import { promises as fs } from 'fs'
import * as path from 'path'

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
  const stepId = base.substring(underIdx + 1)
  return stepId || null
}

/**
 * Read the sub-second timestamp from the first line of a block file.
 * Only reads the first 256 bytes — enough for a timestamp line.
 * Returns the ISO timestamp string, or null if not found/readable.
 */
export async function readBlockTimestamp(filePath: string): Promise<string | null> {
  const fh = await fs.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(256)
    const { bytesRead } = await fh.read(buf, 0, 256, 0)
    if (bytesRead === 0) return null
    const firstLine = buf.toString('utf8', 0, bytesRead).split('\n')[0] || ''
    if (!firstLine) return null
    const match = firstLine.match(TIMESTAMP_REGEX)
    return match ? match[1] : null
  } finally {
    await fh.close()
  }
}

/**
 * Scan a blocks directory and return all step timestamps.
 * Returns one entry per unique step ID, using the earliest timestamp found across all pages.
 */
export async function scanBlocksDir(blocksDir: string): Promise<Array<{ id: string; ts: string }>> {
  const earliest = new Map<string, string>()

  const files = await fs.readdir(blocksDir)
  for (const file of files) {
    const stepId = parseBlockFilename(file)
    if (!stepId) continue

    try {
      const ts = await readBlockTimestamp(path.join(blocksDir, file))
      if (ts) {
        const current = earliest.get(stepId)
        if (!current || ts < current) {
          earliest.set(stepId, ts)
        }
      }
    } catch { /* skip unreadable files */ }
  }

  return [...earliest.entries()].map(([id, ts]) => ({ id, ts }))
}
