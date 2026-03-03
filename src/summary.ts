import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as github from '@actions/github'
import { promises as fs } from 'fs'

const AUDIT_LOG = '/tmp/cargowall-audit.json'
const CARGOWALL_LOG = '/tmp/cargowall.log'
const STEP_PLAN_FILE = '/tmp/cargowall-step-plan.json'
const STEP_TIMESTAMPS_FILE = '/tmp/cargowall-step-timestamps.jsonl'
const WATCHER_LOG_FILE = '/tmp/cargowall-watcher.log'

export async function generateSummary(): Promise<void> {
  // Check if audit log exists and has content
  try {
    const stat = await fs.stat(AUDIT_LOG)
    if (stat.size === 0) {
      core.info('Audit log is empty, skipping summary')
      return
    }
  } catch {
    core.info('No audit log found, skipping summary')
    return
  }

  core.startGroup('Generating Audit Summary')

  try {
    // Try to get step timing from GitHub API
    let stepsJson = '[]'
    let jobStatus = 'success'
    let currentJobName = ''
    const token = process.env.GITHUB_TOKEN
    const runId = github.context.runId

    if (token && runId) {
      try {
        core.info('Fetching step timing from GitHub API...')
        const octokit = github.getOctokit(token)
        const { data } = await octokit.rest.actions.listJobsForWorkflowRun({
          owner: github.context.repo.owner,
          repo: github.context.repo.repo,
          run_id: runId,
        })

        if (data.jobs && data.jobs.length > 0) {
          // Find the current job - match by runner name or use first job
          const currentJob = data.jobs.find(
            j => j.runner_name === process.env.RUNNER_NAME
          ) ?? data.jobs[0]

          currentJobName = currentJob.name

          // Infer job status from conclusion or step outcomes
          // The post step runs before the job formally completes, so conclusion may be null
          // Normalize GitHub's British 'cancelled' to our proto's American 'canceled'
          if (currentJob.conclusion) {
            jobStatus = currentJob.conclusion === 'cancelled' ? 'canceled' : currentJob.conclusion
          } else if (currentJob.steps?.some(s => s.conclusion === 'cancelled')) {
            jobStatus = 'canceled'
          } else if (currentJob.steps?.some(s => s.conclusion === 'failure')) {
            jobStatus = 'failure'
          }

          if (currentJob.steps && currentJob.steps.length > 0) {
            const steps = currentJob.steps.map(s => ({
              name: s.name,
              started_at: s.started_at,
              completed_at: s.completed_at,
            }))
            stepsJson = JSON.stringify(steps)
            core.info('Generating summary with step correlation...')
          }

          // Enhance step timestamps with sub-second precision from _diag watcher
          try {
            // Kill the watcher
            const watcherPid = core.getState('watcher-pid')
            if (watcherPid) {
              await exec.exec('kill', [watcherPid], { ignoreReturnCode: true, silent: true })
            }

            // Dump watcher debug log
            const watcherLog = await fs.readFile(WATCHER_LOG_FILE, 'utf8').catch(() => '')
            if (watcherLog) core.info(`Watcher log:\n${watcherLog.trimEnd()}`)

            // Read step plan (stepId → internal name) and watcher timestamps
            const planContent = await fs.readFile(STEP_PLAN_FILE, 'utf8')
            const stepPlan: Record<string, string> = JSON.parse(planContent)

            const tsContent = await fs.readFile(STEP_TIMESTAMPS_FILE, 'utf8').catch(() => '')
            const tsEntries = tsContent.trim().split('\n').filter(Boolean)
              .map(line => JSON.parse(line) as { id: string; ts: string })
            core.info(`Step plan: ${Object.keys(stepPlan).length} steps, watcher timestamps: ${tsEntries.length}`)

            // Build ordered list of (internalName, sub-second timestamp)
            // Preserve null entries for steps without watcher data to maintain positional alignment
            const planSteps = Object.entries(stepPlan) // [stepId, internalName][] in plan order
            const stepTimestamps: Array<{ name: string; ts: string | null }> = []
            for (const [stepId, name] of planSteps) {
              const entry = tsEntries.find(e => e.id === stepId)
              stepTimestamps.push({ name, ts: entry ? entry.ts : null })
            }

            // Match to API steps by order
            // API steps include "Set up job" and "Complete job" which aren't in the plan
            // Plan steps correspond to the API steps between those bookends, in order
            if (stepTimestamps.length > 0) {
              const apiSteps = JSON.parse(stepsJson) as Array<{ name: string; started_at: string | null; completed_at: string | null }>

              // Find the plan steps window in API steps (skip "Set up job" at start)
              let apiIdx = 0
              while (apiIdx < apiSteps.length && apiSteps[apiIdx].name === 'Set up job') apiIdx++

              let enhanced = 0
              for (const st of stepTimestamps) {
                if (apiIdx >= apiSteps.length) break
                if (st.ts) {
                  // Set started_at with sub-second precision
                  apiSteps[apiIdx].started_at = st.ts
                  // Set previous step's completed_at to this step's started_at
                  if (apiIdx > 0 && apiSteps[apiIdx - 1].started_at) {
                    apiSteps[apiIdx - 1].completed_at = st.ts
                  }
                  enhanced++
                }
                apiIdx++ // Always advance — maintains positional alignment
              }

              stepsJson = JSON.stringify(apiSteps)
              core.info(`Enhanced ${enhanced} steps with sub-second timestamps`)
            }
          } catch (err) {
            core.info(`Sub-second step enhancement skipped: ${err}`)
          }
        }
      } catch (error) {
        core.info(`Could not fetch step timing: ${error}`)
        core.info('Hint: ensure the job has "permissions: actions: read" for step correlation')
        core.info('Generating summary without step correlation...')
      }
    } else {
      if (!token) {
        core.info('No GITHUB_TOKEN available, generating basic summary...')
      } else {
        core.info('Missing run context, generating basic summary...')
      }
    }

    // Build summary command args
    const summaryArgs = ['summary', '--audit-log', AUDIT_LOG, '--steps', stepsJson]

    // Add API push flags if api-url is configured
    const apiUrl = core.getInput('api-url')
    if (apiUrl) {
      summaryArgs.push('--api-url', apiUrl)
      summaryArgs.push('--job-key', github.context.job)
      summaryArgs.push('--job-name', currentJobName || github.context.job)

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
      summaryArgs.push('--default-action', core.getInput('default-action') || 'deny')
      summaryArgs.push('--job-status', jobStatus)

      // Get OIDC token for API authentication
      try {
        const audience = core.getInput('api-audience') || 'codecargo'
        const idToken = await core.getIDToken(audience)
        summaryArgs.push('--token', idToken)
      } catch (error) {
        core.warning(
          `Failed to get OIDC token for API push. Ensure the workflow has "permissions: id-token: write". Error: ${error}`
        )
      }
    }

    // Run cargowall summary command
    let summaryOutput = ''
    const summaryResult = await exec.exec('cargowall', summaryArgs, {
      ignoreReturnCode: true,
      listeners: {
        stdout: (data: Buffer) => { summaryOutput += data.toString() }
      }
    })

    if (summaryResult === 0 && summaryOutput) {
      await core.summary.addRaw(summaryOutput).write()
      core.info('Audit summary written to workflow summary')
    } else {
      core.warning('Failed to generate audit summary with step correlation')

      // Fall back to basic summary without step correlation
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
  } catch (error) {
    core.warning(`Failed to generate audit summary: ${error}`)
  }

  // Append full cargowall log to summary
  try {
    const log = await fs.readFile(CARGOWALL_LOG, 'utf8')
    if (log) {
      await core.summary
        .addRaw('<details><summary>CargoWall Process Log</summary>\n\n```\n')
        .addRaw(log)
        .addRaw('\n```\n</details>\n')
        .write()
    }
  } catch {
    // No log file available
  }

  // Audit log left in place — cargowall is still running and VM is ephemeral

  core.endGroup()
}
