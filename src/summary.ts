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

type StepEntry = { name: string; started_at: string | null; completed_at: string | null }

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
    // This also gives the watcher more time to poll before we kill it.
    let apiSteps: StepEntry[] | null = null
    const skipActionsApi = core.getInput('skip-actions-api') === 'true'
    if (token && runId && !skipActionsApi) {
      try {
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

    // If we didn't make an API call, the watcher hasn't had the natural delay
    // that the API round-trip provides. Wait for the watcher to have actually
    // captured data. Block files get cleaned up during the run, so the watcher
    // must capture timestamps in real-time — we can't read them after the fact.
    if (!apiSteps) {
      // Without the API call, there's no natural delay for the watcher.
      // Poll the watcher output file until it has entries, with a 2s timeout
      // to handle slow Node.js cold starts on some runners.
      const deadline = Date.now() + 2000
      while (Date.now() < deadline) {
        const content = await fs.readFile(STEP_TIMESTAMPS_FILE, 'utf8').catch(() => '')
        const lines = content.trim().split('\n').filter(Boolean).length
        if (lines > 0) {
          // The watcher captured its first entry. Give it 1s more to sweep the
          // remaining block files (~10 polls at 100ms interval).
          await new Promise(resolve => setTimeout(resolve, 1000))
          break
        }
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
        // Remove API-related args so the binary doesn't attempt an unauthenticated push
        for (const flag of ['--api-url', '--job-key', '--job-name', '--mode', '--default-action', '--job-status']) {
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

interface DiagData {
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
    const stepPlan: Record<string, string> = JSON.parse(planContent)
    const planSteps = Object.entries(stepPlan)
    const planStepIds = new Set(Object.keys(stepPlan))

    // Read watcher timestamps (stepId → sub-second ts)
    let tsEntries: Array<{ id: string; ts: string }> = []
    const tsContent = await fs.readFile(STEP_TIMESTAMPS_FILE, 'utf8').catch(() => '')
    tsEntries = tsContent.trim().split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as { id: string; ts: string })

    const diagDir = core.getState('diag-dir') || await findDiagDir()

    core.info(`Step plan: ${planStepIds.size} steps, watcher timestamps: ${tsEntries.length}`)

    // Scan remaining block files for entries the watcher missed (e.g. post steps).
    // Block files get cleaned up aggressively, so scan immediately — no delay.
    if (diagDir) {
      try {
        const watcherIds = new Set(tsEntries.map(e => e.id))
        const scanned = await scanBlocks(diagDir)
        const missed = scanned.filter(e => !watcherIds.has(e.id))
        if (missed.length > 0) {
          tsEntries = [...tsEntries, ...missed]
          core.info(`Block scan found ${missed.length} entries watcher missed`)
        }
      } catch { /* ignore */ }
    }

    // Read Worker log runtime entries — authoritative source for step display names
    let executedNames: string[] = []
    if (diagDir) {
      executedNames = await parseExecutedSteps(diagDir)
      core.info(`Worker log executed steps: ${executedNames.length} (${executedNames.join(', ')})`)
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
function enhanceApiStepsWithDiag(apiSteps: StepEntry[], diag: DiagData): StepEntry[] {
  if (diag.tsEntries.length === 0) {
    core.info('No _diag timestamps available, using API steps as-is')
    return apiSteps
  }

  // Build ordered list of (name, sub-second timestamp) from plan steps + watcher
  // Preserve null entries for steps without watcher data to maintain positional alignment
  const stepTimestamps: Array<{ name: string; ts: string | null }> = []
  for (const [stepId, name] of diag.planSteps) {
    const entry = diag.tsEntries.find(e => e.id === stepId)
    stepTimestamps.push({ name, ts: entry ? entry.ts : null })
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
function buildStepsFromDiag(diag: DiagData): StepEntry[] {
  if (diag.tsEntries.length === 0) return []

  // Build a stepId → display name mapping for plan steps.
  // Plan step IDs are in execution order. Worker log names are in the same order.
  const idToName = new Map<string, string>()
  const planIds = diag.planSteps.map(([id]) => id)
  for (let i = 0; i < planIds.length && i < diag.executedNames.length; i++) {
    idToName.set(planIds[i], diag.executedNames[i])
  }

  // Sort all entries by timestamp
  const allSorted = [...diag.tsEntries].sort((a, b) => a.ts.localeCompare(b.ts))

  // Skip "Set up job" bookend (before the first plan step — CW not running).
  // Keep plan steps + post steps (after the last plan step).
  const planSet = diag.planStepIds
  const firstPlanIdx = allSorted.findIndex(e => planSet.has(e.id))
  if (firstPlanIdx < 0) return []
  const relevant = allSorted.slice(firstPlanIdx)

  // Name post steps from the Worker log.
  // The executed names list has main step names followed by post step names.
  // Post step names start after the last plan step name.
  const postNames: string[] = diag.executedNames.slice(planIds.length)
  let postIdx = 0

  const steps: StepEntry[] = []
  for (let i = 0; i < relevant.length; i++) {
    const entry = relevant[i]
    const isPlan = planSet.has(entry.id)

    let name: string
    if (isPlan) {
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

