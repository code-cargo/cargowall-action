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
 *
 * Two discovery models, tried in that order and kept apart. The primary one
 * is the process that owns this job: the action's node process descends
 * from Runner.Worker, whose /proc/<pid>/exe is <root>/bin/Runner.Worker,
 * and _diag is a sibling of bin. That is layout-agnostic — hosted runners
 * live under /home/runner/actions-runner/cached/<version>, ARC images
 * install the runner at /home/runner itself, a self-hosted install can be
 * anywhere — where the fixed candidate list is not (ARC runs used to fall
 * through it and post `--steps []`, leaving every ordinal unnamed).
 *
 * The known layouts run only when ancestry cannot produce an accessible
 * _diag, never merged into one candidate list: an existing directory is a
 * weak acceptance test (a runner image can ship an empty cached/_diag), so
 * a derived path must not be allowed to win on existence alone over the
 * versioned path those fallbacks deliberately try first.
 *
 * startPid is where the walk begins; the default is this process, which is
 * the only thing production ever wants.
 */
export async function findDiagDir(startPid: number = process.pid): Promise<string | null> {
  const root = await findRunnerRootFromAncestry(startPid)
  if (root) {
    const diag = path.join(root, '_diag')
    try {
      await fs.access(diag)
      return diag
    } catch { /* runner root without a _diag — try the known layouts */ }
  }
  return findDiagDirFromKnownLayouts()
}

/**
 * The fixed GitHub-hosted and ARC install locations, for when the ancestry
 * walk comes up empty (a container job, where the worker runs on the host,
 * or a /proc this process cannot read). The versioned path
 * (e.g. cached/2.333.1/_diag) takes priority — some runner images have a
 * cached/_diag without logs.
 */
async function findDiagDirFromKnownLayouts(): Promise<string | null> {
  const candidates = [
    ...(await findVersionedDiagDirs()),
    '/home/runner/actions-runner/cached/_diag',
    '/home/runner/actions-runner/_diag',
    '/home/runner/_diag',
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
 * Walk the parent chain from startPid for the runner that owns this job and
 * return its install root, or null when no ancestor is one: a container job
 * (the worker lives on the host), or a /proc that cannot be read at all.
 *
 * The match is the exe path, not the process name — the install root is
 * what /proc/<pid>/exe carries, while comm is a truncated 16-byte label
 * that cannot produce one. So an unreadable exe (EACCES under Yama, a
 * deleted binary) means "not this pid" and the walk continues: a Worker
 * whose exe is hidden still leaves the Listener above it to match.
 */
export async function findRunnerRootFromAncestry(startPid: number = process.pid): Promise<string | null> {
  let pid = startPid
  for (let hop = 0; hop < 64 && pid > 1; hop++) {
    try {
      const root = runnerRootFromExe(await fs.readlink(`/proc/${pid}/exe`))
      if (root) return root
    } catch { /* unreadable exe — keep walking */ }

    let stat: string
    try {
      stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8')
    } catch {
      return null
    }
    const ppid = parsePpid(stat)
    if (ppid === null) return null
    pid = ppid
  }
  return null
}

/**
 * `<root>/bin/Runner.Worker` → `<root>`, and null for anything that is not
 * a runner binary in a bin directory — the check that keeps a process which
 * merely looks like the runner from yielding a made-up root. /proc paths are
 * Linux, so they are parsed as posix wherever the tests run.
 */
export function runnerRootFromExe(exe: string): string | null {
  const cleaned = exe.replace(/ \(deleted\)$/, '')
  const base = path.posix.basename(cleaned)
  if (base !== 'Runner.Worker' && base !== 'Runner.Listener') return null
  const bin = path.posix.dirname(cleaned)
  if (path.posix.basename(bin) !== 'bin') return null
  return path.posix.dirname(bin)
}

/**
 * Parent pid from /proc/<pid>/stat. The comm field is parenthesised and may
 * itself contain spaces or parentheses, so parse from the last ')': state
 * is the field after it, ppid the one after that.
 */
export function parsePpid(stat: string): number | null {
  const end = stat.lastIndexOf(')')
  if (end < 0) return null
  const fields = stat.slice(end + 1).trim().split(/\s+/)
  const ppid = Number(fields[1])
  return Number.isInteger(ppid) ? ppid : null
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
