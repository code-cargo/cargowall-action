import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as github from '@actions/github'
import { promises as fs } from 'fs'
import { findDiagDir, readWorkerSteps } from './diag'

const AUDIT_LOG = '/tmp/cargowall-audit.json'
const CARGOWALL_LOG = '/tmp/cargowall.log'

export type StepEntry = { name: string; started_at: string | null; completed_at: string | null }

/**
 * Whether `cargowall summary` is worth invoking at all.
 *
 * That one invocation does two jobs: it renders the markdown summary AND
 * performs the CodeCargo push. So an absent or empty audit log is not a reason
 * to bail — the binary treats it as a zero-event push and still reports the job
 * record, effective mode, status, version and any downgrade. Skipping on a
 * missing log is what made `audit-summary: false` jobs invisible to the
 * dashboard (#71). Only skip when there is genuinely nothing to do.
 */
export function shouldRunSummary(args: { haveEvents: boolean; canPush: boolean }): boolean {
  return args.haveEvents || args.canPush
}

/**
 * Run `cargowall summary`, which both renders the markdown summary and pushes
 * the job record to the CodeCargo API.
 *
 * `render: false` suppresses only the workflow-summary output — the push still
 * happens, because the job record, effective mode, job status, cargowall
 * version and any downgrade record are independent of event collection.
 */
export async function generateSummary(opts: { render: boolean } = { render: true }): Promise<void> {
  const { render } = opts
  const offline = core.getInput('offline') === 'true'
  const apiUrl = core.getInput('api-url')
  const canPush = !!apiUrl && !offline

  let haveEvents = false
  try {
    haveEvents = (await fs.stat(AUDIT_LOG)).size > 0
  } catch {
    // No audit log — cargowall may have been started without one.
  }
  if (!shouldRunSummary({ haveEvents, canPush })) {
    core.info('No audit events and no API push configured, skipping summary')
    return
  }

  core.startGroup('Generating Audit Summary')

  try {
    let stepsJson = '[]'

    // Step names and start times come from the runner's local Worker log —
    // deliberately NOT the GitHub Actions API (v2 dropped the actions:read
    // permission). Attribution itself is causal (eBPF process/socket tags);
    // the binary uses step start times only to NAME ordinals, matched
    // monotonically against its step-boundary events, which are stamped by
    // the same runner clock as the Worker log. API timestamps come from
    // GitHub's service clock, and that skew is exactly what mis-named
    // ordinals when both sources were in play.
    try {
      const diagDir = await findDiagDir()
      const workerSteps = diagDir ? await readWorkerSteps(diagDir) : []
      if (workerSteps.length > 0) {
        stepsJson = JSON.stringify(workerSteps)
        core.info(`Built ${workerSteps.length} steps from the runner Worker log`)
      } else {
        core.info('No step data available — step ordinals will render unnamed')
      }
    } catch (err) {
      core.info(`Worker log step read failed: ${err}`)
    }

    // Build summary command args
    const summaryArgs = ['summary', '--audit-log', AUDIT_LOG, '--steps', stepsJson]

    // Add API push flags if api-url is configured and offline mode is not enabled
    if (canPush) {
      summaryArgs.push('--api-url', apiUrl)
      summaryArgs.push('--job-key', github.context.job)
      summaryArgs.push('--job-name', github.context.job)
      const jobId = core.getInput('job-id')
      if (jobId) {
        summaryArgs.push('--job-run-id', jobId)
      }

      // Prefer the effective mode written by the Go binary (which may have
      // been overridden by the SaaS policy) over the static Action input.
      let effectiveMode = core.getInput('mode') || 'enforce'
      try {
        const modeFromFile = (await fs.readFile('/tmp/cargowall-mode', 'utf8')).trim()
        if (modeFromFile) effectiveMode = modeFromFile
      } catch {
        // State file not present — use Action input as fallback
      }
      summaryArgs.push('--mode', effectiveMode)
      summaryArgs.push('--default-action', 'deny')
      // --job-status is never passed: it only ever came from the Actions API,
      // which v2 no longer calls. The Go binary sends UNSPECIFIED (proto
      // value 0); if job status matters on the dashboard, the GitHub App can
      // enrich it server-side from workflow_job webhooks.

      // Get OIDC token for API authentication
      try {
        const idToken = await core.getIDToken('codecargo')
        summaryArgs.push('--token', idToken)
      } catch (error) {
        // Info, not warning: with the push no longer gated on audit-summary,
        // every repo without `id-token: write` (most non-customers) hits this
        // on every job — a per-job warning annotation for a working setup is
        // noise. Customers with a genuinely broken push still see the message
        // in the step log, and the missing job on the dashboard is the signal.
        core.info(
          `No OIDC token available for the API push — skipping it. For CodeCargo platform ` +
            `integration the workflow needs "permissions: id-token: write". (${error})`
        )
        // Remove API-related args so the binary doesn't attempt an unauthenticated push
        for (const flag of ['--api-url', '--job-key', '--job-name', '--job-run-id', '--mode', '--default-action']) {
          const idx = summaryArgs.findIndex(a => a === flag)
          if (idx !== -1) summaryArgs.splice(idx, 2) // remove flag and its value
        }
      }
    }

    // Run cargowall summary command. The stdout (the rendered markdown) is
    // only accumulated when it will be written to the workflow summary.
    let summaryOutput = ''
    const summaryResult = await exec.exec('cargowall', summaryArgs, {
      ignoreReturnCode: true,
      listeners: {
        stdout: (data: Buffer) => { if (render) summaryOutput += data.toString() }
      }
    })

    // Three distinct outcomes (the push, when configured, happened inside the
    // invocation either way):
    //   exit 0, rendering off       → done, say so accurately
    //   exit 0, markdown produced   → write it to the workflow summary
    //   anything else, rendering on → warn and retry without step correlation
    //     (includes exit 0 with EMPTY stdout — reachable via the zero-event
    //     push shape — which must not be mislabelled "rendering disabled")
    if (summaryResult === 0 && !render) {
      core.info('Audit summary complete (rendering disabled)')
    } else if (summaryResult === 0 && summaryOutput) {
      await core.summary.addRaw(summaryOutput).write()
      core.info('Audit summary written to workflow summary')
    } else {
      core.warning('Failed to generate audit summary with step correlation')

      // Fall back to a basic summary without step correlation. Rendering-only:
      // it carries no API flags, so there is nothing to retry when the summary
      // is not being rendered.
      if (render) {
        summaryOutput = ''
        const fallbackResult = await exec.exec('cargowall', ['summary', '--audit-log', AUDIT_LOG, '--steps', '[]'], {
          ignoreReturnCode: true,
          listeners: {
            stdout: (data: Buffer) => { summaryOutput += data.toString() }
          }
        })

        if (fallbackResult === 0 && summaryOutput) {
          await core.summary.addRaw(summaryOutput).write()
          core.info('Basic audit summary written to workflow summary')
        }
      }
    }
  } catch (error) {
    core.warning(`Failed to generate audit summary: ${error}`)
  }

  // Append full cargowall log to summary. The plain-text separator before
  // the <details> markup is load-bearing (#82): in plain-text renderings the
  // HTML is invisible chrome, so without it the raw log tail visually
  // attaches to whatever section the summary printed last — the final
  // attribution bucket heading — and its lines read as that bucket's
  // contents.
  if (render) {
    try {
      const log = await fs.readFile(CARGOWALL_LOG, 'utf8')
      if (log) {
        await core.summary
          .addRaw('\n---\n\n### CargoWall Process Log\n\n')
          .addRaw('Raw daemon log, unbucketed — not part of the attribution tables above.\n\n')
          .addRaw('<details><summary>Expand full log</summary>\n\n```\n')
          .addRaw(log)
          .addRaw('\n```\n</details>\n')
          .write()
      }
    } catch {
      // No log file available
    }
  }

  // Audit log left in place — cargowall is still running and VM is ephemeral

  core.endGroup()
}


