import { promises as fs } from 'fs'
import * as path from 'path'
import { parseBlockFilename, TIMESTAMP_REGEX } from './blocks'

const blocksDir = process.argv[2]
const outputFile = process.argv[3]

const logFile = '/tmp/cargowall-watcher.log'

async function log(msg: string) {
  await fs.appendFile(logFile, `${new Date().toISOString()} ${msg}\n`).catch(() => {})
}

const seen = new Set<string>()
const seenStepIds = new Set<string>()

log(`watcher started: blocks=${blocksDir} output=${outputFile}`)

async function poll() {
  try {
    const files = await fs.readdir(blocksDir)
    for (const file of files) {
      if (seen.has(file)) continue

      const stepId = parseBlockFilename(file)
      if (!stepId || seenStepIds.has(stepId)) {
        seen.add(file)
        continue
      }

      try {
        const fh = await fs.open(path.join(blocksDir, file), 'r')
        try {
          const buf = Buffer.alloc(256)
          const { bytesRead } = await fh.read(buf, 0, 256, 0)
          if (bytesRead === 0) {
            // File exists but is empty — retry next poll (runner hasn't written yet)
            continue
          }
          const firstLine = buf.toString('utf8', 0, bytesRead).split('\n')[0] || ''
          const match = firstLine.match(TIMESTAMP_REGEX)
          if (match) {
            seen.add(file)
            seenStepIds.add(stepId)
            log(`timestamp: stepId=${stepId} ts=${match[1]}`)
            await fs.appendFile(outputFile, JSON.stringify({ id: stepId, ts: match[1] }) + '\n')
          } else {
            // No match — runner may still be writing the first line.
            // Don't add to seen so we retry on the next poll.
            log(`no timestamp match in ${file}, will retry`)
          }
        } finally {
          await fh.close()
        }
      } catch (err) {
        // File may have been deleted or not yet readable — retry next poll
        log(`read error for ${file}: ${err}`)
      }
    }
  } catch (err) {
    log(`readdir error: ${err}`)
  }
}

// Poll every 200ms in a non-reentrant loop
async function startPolling() {
  await poll()
  setTimeout(startPolling, 200)
}

startPolling()
