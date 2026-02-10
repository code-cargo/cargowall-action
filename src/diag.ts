import { promises as fs } from 'fs'
import * as path from 'path'

/**
 * Find the runner's _diag directory which contains Worker logs and blocks/.
 * Returns the path or null if not found.
 */
export async function findDiagDir(): Promise<string | null> {
  // Check known paths first
  const candidates = [
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
