import { promises as fs, createReadStream } from 'fs'
import * as path from 'path'
import { createInterface } from 'readline'

export const TIMESTAMP_REGEX = /^\uFEFF?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)/

/**
 * Extract the step ID from a block filename.
 * Block files are named: {jobId}_{stepId}.{page}
 * Returns the stepId, or null if the filename doesn't match the expected pattern.
 */
export function parseBlockFilename(file: string): string | null {
  const dotIdx = file.lastIndexOf('.')
  const base = dotIdx >= 0 ? file.substring(0, dotIdx) : file
  const underIdx = base.indexOf('_')
  if (underIdx < 0) return null
  return base.substring(underIdx + 1)
}

/**
 * Read the sub-second timestamp from the first line of a block file.
 * Only reads the first line rather than the entire file.
 * Returns the ISO timestamp string, or null if not found/readable.
 */
export async function readBlockTimestamp(filePath: string): Promise<string | null> {
  const rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }) })
  try {
    for await (const line of rl) {
      if (!line) return null
      const match = line.match(TIMESTAMP_REGEX)
      return match ? match[1] : null
    }
    return null // empty file
  } finally {
    rl.close()
  }
}

/**
 * Scan a blocks directory and return all step timestamps.
 * Returns one entry per unique step ID (first page only).
 */
export async function scanBlocksDir(blocksDir: string): Promise<Array<{ id: string; ts: string }>> {
  const results: Array<{ id: string; ts: string }> = []
  const seenSteps = new Set<string>()

  const files = (await fs.readdir(blocksDir)).sort()
  for (const file of files) {
    const stepId = parseBlockFilename(file)
    if (!stepId || seenSteps.has(stepId)) continue

    try {
      const ts = await readBlockTimestamp(path.join(blocksDir, file))
      if (ts) {
        seenSteps.add(stepId)
        results.push({ id: stepId, ts })
      }
    } catch { /* skip unreadable files */ }
  }

  return results
}
