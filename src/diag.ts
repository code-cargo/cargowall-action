import { promises as fs } from 'fs'
import * as path from 'path'
import { scanBlocksDir } from './blocks'

/**
 * Find the runner's _diag directory which contains Worker logs and blocks/.
 * Returns the path or null if not found.
 */
export async function findDiagDir(): Promise<string | null> {
  // Check known paths first. The versioned path (e.g. cached/2.333.1/_diag) takes
  // priority — some runner images have a cached/_diag without blocks/.
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

/**
 * Parse the job plan from the latest Worker log to get a stepId → name mapping.
 * The Worker log contains a JSON block with "steps": [{ "id": "...", "name": "...", "displayName": "..." }].
 * Returns an ordered record of { [stepId]: internalName }.
 */
export async function parseJobPlan(diagDir: string): Promise<Record<string, string>> {
  const stepIdToName: Record<string, string> = {}

  const files = await fs.readdir(diagDir)
  const workerLogFiles = files.filter(f => f.startsWith('Worker_')).sort()
  if (workerLogFiles.length === 0) return stepIdToName

  const workerContent = await fs.readFile(
    path.join(diagDir, workerLogFiles[workerLogFiles.length - 1]),
    'utf8'
  )
  const workerLines = workerContent.split('\n')

  // Find the job plan JSON and extract step id + display name
  // The plan has "steps": [ { "id": "...", "name": "...", "displayName": "..." }, ... ]
  const planStart = workerLines.findIndex(l => /"steps"\s*:\s*\[/.test(l))
  if (planStart < 0) return stepIdToName

  // Collect lines until we find the closing of the steps array
  let bracketDepth = 0
  let planJson = ''
  let started = false
  for (let i = planStart; i < workerLines.length && i < planStart + 500; i++) {
    const line = workerLines[i]
    if (!started && line.includes('"steps"')) {
      planJson = '{'
      started = true
    }
    if (started) {
      planJson += line + '\n'
      bracketDepth += (line.match(/\[/g) || []).length - (line.match(/\]/g) || []).length
      if (bracketDepth <= 0 && started) {
        planJson += '}'
        break
      }
    }
  }

  // Strip any non-JSON prefix (e.g. Worker log timestamp) from the first line
  const stepsIdx = planJson.indexOf('"steps"')
  if (stepsIdx > 1) {
    planJson = '{ ' + planJson.substring(stepsIdx)
  }

  // Try to parse the extracted JSON properly first
  try {
    const parsed = JSON.parse(planJson)
    if (Array.isArray(parsed.steps)) {
      for (const step of parsed.steps) {
        if (step.id && (step.displayName || step.name)) {
          stepIdToName[step.id] = step.displayName || step.name
        }
      }
      return stepIdToName
    }
  } catch { /* JSON incomplete or malformed, fall back to regex */ }

  // Fallback: use the original regex approach that works on raw text
  const stepRegex = /"id"\s*:\s*"([^"]+)"[\s\S]*?"(?:displayName|name)"\s*:\s*"([^"]+)"/g
  let match
  while ((match = stepRegex.exec(planJson)) !== null) {
    stepIdToName[match[1]] = match[2]
  }

  return stepIdToName
}

/**
 * Scan the blocks directory for step timestamps.
 * Used to pick up entries the watcher missed (e.g. post steps that appeared
 * after the watcher's last poll). Only recent block files survive cleanup.
 */
export async function scanBlocks(diagDir: string): Promise<Array<{ id: string; ts: string }>> {
  return scanBlocksDir(path.join(diagDir, 'blocks'))
}

/**
 * Parse the Worker log for runtime step execution entries to get ALL step names
 * including post steps (which are not in the job plan).
 * Scans for "Processing step: DisplayName='<name>'" lines written by the runner's
 * Trace.Info for every step as it executes.
 * Returns an ordered list of display names in execution order.
 */
export async function parseExecutedSteps(diagDir: string): Promise<string[]> {
  const files = await fs.readdir(diagDir)
  const workerLogFiles = files.filter(f => f.startsWith('Worker_')).sort()
  if (workerLogFiles.length === 0) return []

  const workerContent = await fs.readFile(
    path.join(diagDir, workerLogFiles[workerLogFiles.length - 1]),
    'utf8'
  )

  const names: string[] = []
  const regex = /Processing step: DisplayName='([^']+)'/g
  let match
  while ((match = regex.exec(workerContent)) !== null) {
    names.push(match[1])
  }

  return names
}
