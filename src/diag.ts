import { promises as fs } from 'fs'
import * as path from 'path'
import type { StepEntry } from './summary'

/**
 * Step names without `actions: read`: the runner's Worker log in _diag writes
 * a `Processing step: DisplayName='<name>'` trace line as each step starts,
 * prefixed with a second-precision UTC timestamp. That is exactly the shape
 * `cargowall summary --steps` needs — its causal ordinal→step resolution
 * matches its own eBPF step-boundary events against step start times with a
 * monotonic cursor, so second precision suffices and steps that started
 * before cargowall attached simply never win a match. The log is an ordinary
 * append-only file that survives the whole job, so one read at post time is
 * enough — no watcher process, no blocks-dir polling.
 */

/**
 * Find the runner's _diag directory. Returns the path or null if not found.
 */
export async function findDiagDir(): Promise<string | null> {
  // Check known paths first. The versioned path (e.g. cached/2.333.1/_diag)
  // takes priority — some runner images have a cached/_diag without logs.
  const versionedCandidates = await findVersionedDiagDirs()
  const candidates = [
    ...versionedCandidates,
    '/home/runner/actions-runner/cached/_diag',
    '/home/runner/actions-runner/_diag',
  ]

  for (const candidate of candidates) {
    try {
      await fs.access(candidate)
      return candidate
    } catch { /* continue */ }
  }

  // Fallback: scan /home/runner/actions-runner/*/
  try {
    const entries = await fs.readdir('/home/runner/actions-runner', { withFileTypes: true })
    for (const e of entries.filter(e => e.isDirectory())) {
      const candidate = path.join('/home/runner/actions-runner', e.name, '_diag')
      try {
        await fs.access(candidate)
        return candidate
      } catch { /* continue */ }
    }
  } catch { /* continue */ }

  return null
}

/**
 * Find versioned _diag directories like /home/runner/actions-runner/cached/2.333.1/_diag.
 */
async function findVersionedDiagDirs(): Promise<string[]> {
  const results: string[] = []
  try {
    const entries = await fs.readdir('/home/runner/actions-runner/cached', { withFileTypes: true })
    for (const e of entries.filter(e => e.isDirectory() && /^\d/.test(e.name))) {
      results.push(path.join('/home/runner/actions-runner/cached', e.name, '_diag'))
    }
  } catch { /* continue */ }
  return results
}

// One Worker trace line per executed step, e.g.:
//   [2026-08-06 18:23:46Z INFO StepsRunner] Processing step: DisplayName='Run tests', ...
// The prefix is the runner's Tracing format: [<UTC "u" timestamp> <level> <source>].
const STEP_LINE_REGEX =
  /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)Z [^\]]*\].*?Processing step: DisplayName='([^']+)'/

/**
 * Parse Worker log content into the executed steps, in execution order, with
 * RFC3339 start times taken from each trace line's timestamp prefix. A line
 * whose prefix doesn't parse still contributes its name (null started_at —
 * the binary just can't match a boundary to it) rather than shifting every
 * later step's position. Each step's completed_at is chained from the next
 * step's start, mirroring what the GitHub API reports.
 */
export function parseWorkerSteps(content: string): StepEntry[] {
  const steps: StepEntry[] = []
  for (const line of content.split('\n')) {
    const m = line.match(STEP_LINE_REGEX)
    if (m) {
      steps.push({ name: m[3], started_at: `${m[1]}T${m[2]}Z`, completed_at: null })
      continue
    }
    const nameOnly = line.match(/Processing step: DisplayName='([^']+)'/)
    if (nameOnly) {
      steps.push({ name: nameOnly[1], started_at: null, completed_at: null })
    }
  }
  for (let i = 0; i + 1 < steps.length; i++) {
    steps[i].completed_at = steps[i + 1].started_at
  }
  return steps
}

/**
 * Read the latest Worker log in diagDir and parse its executed steps.
 */
export async function readWorkerSteps(diagDir: string): Promise<StepEntry[]> {
  const files = await fs.readdir(diagDir)
  const workerLogs = files.filter(f => f.startsWith('Worker_')).sort()
  if (workerLogs.length === 0) return []

  const content = await fs.readFile(
    path.join(diagDir, workerLogs[workerLogs.length - 1]),
    'utf8'
  )
  return parseWorkerSteps(content)
}
