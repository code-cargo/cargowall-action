import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as github from '@actions/github'
import { promises as fs } from 'fs'
import { findDiagDir, parseExecutedSteps, scanBlocks } from './diag'

const AUDIT_LOG = '/tmp/cargowall-audit.json'
const CARGOWALL_LOG = '/tmp/cargowall.log'
const STEP_PLAN_FILE = '/tmp/cargowall-step-plan.json'
const STEP_TIMESTAMPS_FILE = '/tmp/cargowall-step-timestamps.jsonl'
const WATCHER_LOG_FILE = '/tmp/cargowall-watcher.log'

export type StepEntry = { name: string; started_at: string | null; completed_at: string | null }

// Decide whether to call the GitHub Actions REST API for step-name/job-status
// enrichment. Pure / IO-free so it can be unit-tested. Returns true only when
// a token and runId are available AND neither the `skip-actions-api` input
// nor the `CARGOWALL_SKIP_ACTIONS_API` env var is set to 'true'. Either flag
// is sufficient to skip — the env var remains as a power-user override.
export function shouldCallActionsApi(args: {
  token: string
  runId: number
  skipInput: string
  skipEnv: string | undefined
}): boolean {
  if (!args.token) return false
  if (!args.runId) return false
  if (args.skipInput === 'true') return false
  if (args.skipEnv === 'true') return false
  return true
}

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
    let stepsJson = '[]'
    let jobStatus = 'success'
    let currentJobName = ''
    const token = core.getInput('github-token')
    const runId = github.context.runId

    // --- Try GitHub API first (needs actions: read) ---
    // The API round-trip also gives the watcher natural delay to capture data.
    let apiSteps: StepEntry[] | null = null
    // Tracks whether an API call was made (even if it failed). Used to decide
    // whether the watcher needs an explicit wait: if the API was called, the
    // round-trip already provided enough delay; if skipped, we must wait.
    let apiCallMade = false
    const callApi = shouldCallActionsApi({
      token,
      runId,
      skipInput: core.getInput('skip-actions-api'),
      skipEnv: process.env.CARGOWALL_SKIP_ACTIONS_API,
    })
    if (callApi) {
      try {
        apiCallMade = true
        core.info('Fetching step timing from GitHub API...')
        const octokit = github.getOctokit(token)
        const { data } = await octokit.rest.actions.listJobsForWorkflowRun({
          owner: github.context.repo.owner,
          repo: github.context.repo.repo,
          run_id: runId,
        })

        if (data.jobs && data.jobs.length > 0) {
          const currentJob = data.jobs.find(
            (j: { runner_name: string | null }) => j.runner_name === process.env.RUNNER_NAME
          ) ?? data.jobs[0]

          currentJobName = currentJob.name

          // Infer job status from conclusion or step outcomes
          if (currentJob.conclusion) {
            jobStatus = currentJob.conclusion === 'cancelled' ? 'canceled' : currentJob.conclusion
          } else if (currentJob.steps?.some((s: { conclusion: string | null }) => s.conclusion === 'cancelled')) {
            jobStatus = 'canceled'
          } else if (currentJob.steps?.some((s: { conclusion: string | null }) => s.conclusion === 'failure')) {
            jobStatus = 'failure'
          }

          if (currentJob.steps && currentJob.steps.length > 0) {
            apiSteps = currentJob.steps.map((s: { name: string; started_at: string | null; completed_at: string | null }) => ({
              name: s.name,
              started_at: s.started_at,
              completed_at: s.completed_at,
            }))
            core.info(`GitHub API returned ${apiSteps.length} steps`)
          }
        }
      } catch (error) {
        core.info(`GitHub API step fetch failed: ${error}`)
      }
    }

    // When the API call was skipped entirely (no token, or CARGOWALL_SKIP_ACTIONS_API),
    // the watcher hasn't had the natural delay that the API round-trip provides.
    // Wait briefly for the watcher to capture data before we kill it.
    if (!apiCallMade && core.getState('watcher-pid')) {
      const deadline = Date.now() + 2000
      while (Date.now() < deadline) {
        const content = await fs.readFile(STEP_TIMESTAMPS_FILE, 'utf8').catch(() => '')
        const lines = content.trim().split('\n').filter(Boolean).length
        if (lines > 0) break
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }

    // Now kill the watcher and collect _diag data
    const diagData = await collectDiagData()

    if (apiSteps) {
      // API succeeded — enhance with _diag sub-second timestamps
      stepsJson = JSON.stringify(enhanceApiStepsWithDiag(apiSteps, diagData))
    } else {
      // API failed — build steps from _diag only
      const diagSteps = buildStepsFromDiag(diagData)
      if (diagSteps.length > 0) {
        stepsJson = JSON.stringify(diagSteps)
        core.info(`Built ${diagSteps.length} steps from _diag data (no API)`)
      } else {
        core.info('No step data available')
      }
    }

    // Fall back job name to github.context.job if API didn't provide one
    if (!currentJobName) {
      currentJobName = github.context.job
    }

    // Build summary command args
    const summaryArgs = ['summary', '--audit-log', AUDIT_LOG, '--steps', stepsJson]

    // Add API push flags if api-url is configured and offline mode is not enabled
    const offline = core.getInput('offline') === 'true'
    const apiUrl = core.getInput('api-url')
    if (apiUrl && !offline) {
      summaryArgs.push('--api-url', apiUrl)
      summaryArgs.push('--job-key', github.context.job)
      summaryArgs.push('--job-name', currentJobName)
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
      // Only pass job-status when the API provided it. Without the API,
      // jobStatus defaults to 'success' which would be a lie for failed jobs.
      // Omitting it lets the Go binary send UNSPECIFIED (proto value 0).
      if (apiSteps) {
        summaryArgs.push('--job-status', jobStatus)
      }

      // Get OIDC token for API authentication
      try {
        const idToken = await core.getIDToken('codecargo')
        summaryArgs.push('--token', idToken)
      } catch (error) {
        core.warning(
          `Failed to get OIDC token for API push. Ensure the workflow has "permissions: id-token: write". Error: ${error}`
        )
        // Remove API-related args so the binary doesn't attempt an unauthenticated push
        for (const flag of ['--api-url', '--job-key', '--job-name', '--job-run-id', '--mode', '--default-action', '--job-status']) {
          const idx = summaryArgs.findIndex(a => a === flag)
          if (idx !== -1) summaryArgs.splice(idx, 2) // remove flag and its value
        }
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

export interface DiagData {
  planStepIds: Set<string>
  planSteps: Array<[string, string]> // [stepId, name][] in plan order
  tsEntries: Array<{ id: string; ts: string }>
  executedNames: string[]
}

/**
 * Collect all _diag data: kill watcher, read plan, timestamps, Worker log names.
 * This data is used by both the API enhancement path and the _diag-only fallback.
 */
async function collectDiagData(): Promise<DiagData> {
  const empty: DiagData = { planStepIds: new Set(), planSteps: [], tsEntries: [], executedNames: [] }
  try {
    // Kill the watcher first so it flushes
    const watcherPid = core.getState('watcher-pid')
    if (watcherPid) {
      await exec.exec('kill', [watcherPid], { ignoreReturnCode: true, silent: true })
    }

    // Dump watcher debug log
    const watcherLog = await fs.readFile(WATCHER_LOG_FILE, 'utf8').catch(() => '')
    if (watcherLog) core.info(`Watcher log:\n${watcherLog.trimEnd()}`)

    // Read step plan (stepId → name mapping, and ID set for classification)
    const planContent = await fs.readFile(STEP_PLAN_FILE, 'utf8').catch(() => '{}')
    let stepPlan: Record<string, string> = {}
    try {
      stepPlan = JSON.parse(planContent)
    } catch (e) {
      core.info(`Step plan JSON parse failed, continuing without plan: ${e}`)
    }
    const planSteps = Object.entries(stepPlan)
    const planStepIds = new Set(Object.keys(stepPlan))

    // Read watcher timestamps (stepId → sub-second ts)
    const tsEntries: Array<{ id: string; ts: string }> = []
    const tsContent = await fs.readFile(STEP_TIMESTAMPS_FILE, 'utf8').catch(() => '')
    for (const line of tsContent.trim().split('\n').filter(Boolean)) {
      try {
        tsEntries.push(JSON.parse(line) as { id: string; ts: string })
      } catch {
        core.info(`Skipping malformed timestamp line: ${line.substring(0, 80)}`)
      }
    }

    const diagDir = core.getState('diag-dir') || await findDiagDir()

    core.info(`Step plan: ${planStepIds.size} steps, watcher timestamps: ${tsEntries.length}`)

    // Merge block scan results with watcher data. The scan picks up entries the
    // watcher missed (e.g. post steps) and may also find earlier timestamps for
    // steps where the watcher captured a later page first (readdir order varies).
    if (diagDir) {
      try {
        const byId = new Map(tsEntries.map(e => [e.id, e]))
        const scanned = await scanBlocks(diagDir)
        let added = 0
        for (const s of scanned) {
          const existing = byId.get(s.id)
          if (!existing) {
            tsEntries.push(s)
            byId.set(s.id, s)
            added++
          } else if (s.ts < existing.ts) {
            existing.ts = s.ts
          }
        }
        if (added > 0) {
          core.info(`Block scan found ${added} entries watcher missed`)
        }
      } catch { /* ignore */ }
    }

    // Read Worker log runtime entries — authoritative source for step display names
    let executedNames: string[] = []
    if (diagDir) {
      executedNames = await parseExecutedSteps(diagDir)
      core.info(`Worker log executed steps: ${executedNames.length}`)
      if (core.isDebug()) {
        core.debug(`Worker log executed step names: ${executedNames.join(', ')}`)
      }
    }

    return { planStepIds, planSteps, tsEntries, executedNames }
  } catch (err) {
    core.info(`_diag data collection failed: ${err}`)
    return empty
  }
}

/**
 * Enhance API steps with _diag sub-second timestamps.
 * API steps provide the base (all step names, including bookends and post steps).
 * _diag watcher timestamps replace the API's second-precision timestamps where available.
 * This is the same approach as the original code — API is authoritative for names, _diag for timing.
 */
export function enhanceApiStepsWithDiag(apiSteps: StepEntry[], diag: DiagData): StepEntry[] {
  if (diag.tsEntries.length === 0) {
    core.info('No _diag timestamps available, using API steps as-is')
    return apiSteps
  }

  // Build ordered list of (name, sub-second timestamp) from plan steps + watcher
  // Preserve null entries for steps without watcher data to maintain positional alignment
  const tsById = new Map(diag.tsEntries.map(e => [e.id, e.ts]))
  const stepTimestamps: Array<{ name: string; ts: string | null }> = []
  for (const [stepId, name] of diag.planSteps) {
    stepTimestamps.push({ name, ts: tsById.get(stepId) ?? null })
  }

  if (stepTimestamps.length === 0) return apiSteps

  const result = [...apiSteps.map(s => ({ ...s }))]

  // Find the plan steps window in API steps (skip "Set up job" at start)
  let apiIdx = 0
  while (apiIdx < result.length && result[apiIdx].name === 'Set up job') apiIdx++

  let enhanced = 0
  for (const st of stepTimestamps) {
    if (apiIdx >= result.length) break
    if (st.ts) {
      // Replace started_at with sub-second precision
      result[apiIdx].started_at = st.ts
      // Set previous step's completed_at to this step's started_at
      if (apiIdx > 0 && result[apiIdx - 1].started_at) {
        result[apiIdx - 1].completed_at = st.ts
      }
      enhanced++
    }
    apiIdx++ // Always advance — maintains positional alignment
  }

  // Fix timestamp inversions at the enhancement boundary.
  // The last enhanced step may have a sub-second started_at that's after
  // its API-sourced second-precision completed_at. Clear the bad completed_at.
  for (const step of result) {
    if (step.started_at && step.completed_at) {
      const start = new Date(step.started_at).getTime()
      const end = new Date(step.completed_at).getTime()
      if (start > end) {
        step.completed_at = null
      }
    }
  }

  core.info(`Enhanced ${enhanced} steps with sub-second timestamps`)
  return result
}

/**
 * Build steps from _diag data only (fallback when API is not available).
 * Names come from the Worker log (correct display names).
 * Timing comes from the watcher (sub-second precision).
 * The step plan is used to identify which watcher entries are main steps vs bookends.
 */
export function buildStepsFromDiag(diag: DiagData): StepEntry[] {
  if (diag.tsEntries.length === 0) return []

  // Find where CW starts in the executed names list.
  // The start step saved the name of the step it ran in.
  const cwStepName = core.getState('cw-step-name')
  const cwNameIdx = cwStepName ? diag.executedNames.indexOf(cwStepName) : 0
  const nameOffset = cwNameIdx >= 0 ? cwNameIdx : 0

  const planIds = diag.planSteps.map(([id]) => id)
  const watcherIds = new Set(diag.tsEntries.map(e => e.id))

  // CW-onward plan IDs that have watcher entries (= actually executed after CW start).
  // Skipped steps (if: condition) won't have watcher entries, so they're excluded.
  const executedPlanIds = planIds.slice(nameOffset).filter(id => watcherIds.has(id))

  // Map executed IDs to names. The name offset is the position of the first
  // executed plan ID in the full plan — this correctly skips pre-CW names AND
  // any CW-onward plan steps that are missing from the watcher (e.g. the CW
  // step itself if its block file was cleaned up).
  const firstExecPlanIdx = executedPlanIds.length > 0
    ? planIds.indexOf(executedPlanIds[0])
    : nameOffset
  const idToName = new Map<string, string>()
  for (let i = 0; i < executedPlanIds.length && (i + firstExecPlanIdx) < diag.executedNames.length; i++) {
    idToName.set(executedPlanIds[i], diag.executedNames[i + firstExecPlanIdx])
  }

  // Sort all entries by timestamp
  const allSorted = [...diag.tsEntries].sort((a, b) => a.ts.localeCompare(b.ts))

  // Find the CW step in the sorted entries and start from there.
  // Use the plan position directly (planIds[nameOffset]) rather than executedPlanIds[0],
  // because if the CW step's block was cleaned up, executedPlanIds[0] would be the
  // NEXT step, causing misalignment.
  const cwPlanId = nameOffset < planIds.length ? planIds[nameOffset] : null
  let startIdx = -1
  if (cwPlanId && watcherIds.has(cwPlanId)) {
    startIdx = allSorted.findIndex(e => e.id === cwPlanId)
  } else {
    // CW step missing from watcher — find next plan step after it that has an entry
    for (let i = nameOffset + 1; i < planIds.length; i++) {
      if (watcherIds.has(planIds[i])) {
        startIdx = allSorted.findIndex(e => e.id === planIds[i])
        break
      }
    }
  }
  if (startIdx < 0) {
    startIdx = diag.planStepIds.size > 0
      ? allSorted.findIndex(e => diag.planStepIds.has(e.id))
      : Math.min(nameOffset, allSorted.length - 1)
  }
  if (startIdx < 0) return []
  const relevant = allSorted.slice(startIdx)

  // Name post steps from the Worker log.
  // Post step names come after all main step names.
  const mainNameCount = nameOffset + executedPlanIds.length
  const postNames: string[] = diag.executedNames.slice(mainNameCount)
  let postIdx = 0

  const steps: StepEntry[] = []
  for (let i = 0; i < relevant.length; i++) {
    const entry = relevant[i]
    const isPlan = diag.planStepIds.has(entry.id)

    let name: string
    if (diag.planStepIds.size === 0) {
      // No plan data — use executed names by position
      const nameIdx = nameOffset + i
      name = nameIdx < diag.executedNames.length
        ? diag.executedNames[nameIdx]
        : `Step ${steps.length + 1}`
    } else if (isPlan) {
      name = idToName.get(entry.id) || `Step ${steps.length + 1}`
    } else {
      name = postIdx < postNames.length ? postNames[postIdx] : `Post step ${postIdx + 1}`
      postIdx++
    }

    const started_at = entry.ts
    const completed_at = i + 1 < relevant.length ? relevant[i + 1].ts : null

    steps.push({ name, started_at, completed_at })
  }

  return steps
}

