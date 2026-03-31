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
        // Read file once, then decide: empty → retry, has content → parse or give up
        const content = await fs.readFile(path.join(blocksDir, file), 'utf8')
        const firstLine = content.split('\n')[0] || ''
        if (!firstLine) {
          // File exists but is empty — retry next poll (runner hasn't written yet)
          continue
        }
        seen.add(file)
        const match = firstLine.match(TIMESTAMP_REGEX)
        if (match) {
          log(`timestamp: stepId=${stepId} ts=${match[1]}`)
          await fs.appendFile(outputFile, JSON.stringify({ id: stepId, ts: match[1] }) + '\n')
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

// Poll every 100ms
setInterval(poll, 100)
poll()
