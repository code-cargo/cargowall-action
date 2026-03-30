import { promises as fs } from 'fs'
import * as path from 'path'
import { parseBlockFilename, readBlockTimestamp } from './blocks'

const blocksDir = process.argv[2]
const outputFile = process.argv[3]

const logFile = '/tmp/cargowall-watcher.log'

async function log(msg: string) {
  await fs.appendFile(logFile, `${new Date().toISOString()} ${msg}\n`).catch(() => {})
}

const seen = new Set<string>()

log(`watcher started: blocks=${blocksDir} output=${outputFile}`)

async function poll() {
  try {
    const files = await fs.readdir(blocksDir)
    for (const file of files) {
      if (seen.has(file)) continue

      const stepId = parseBlockFilename(file)
      if (!stepId) {
        seen.add(file)
        continue
      }

      try {
        const ts = await readBlockTimestamp(path.join(blocksDir, file))
        if (ts === null && !(await fs.readFile(path.join(blocksDir, file), 'utf8'))) {
          // File exists but is empty — retry next poll (runner hasn't written yet)
          continue
        }
        seen.add(file)
        if (ts) {
          log(`timestamp: stepId=${stepId} ts=${ts}`)
          await fs.appendFile(outputFile, JSON.stringify({ id: stepId, ts }) + '\n')
        } else {
          log(`no timestamp match in ${file}`)
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

// Poll every 50ms
setInterval(poll, 50)
poll()
