import { promises as fs } from 'fs'
import * as path from 'path'

const blocksDir = process.argv[2]
const outputFile = process.argv[3]

const logFile = '/tmp/cargowall-watcher.log'

async function log(msg: string) {
  await fs.appendFile(logFile, `${new Date().toISOString()} ${msg}\n`).catch(() => {})
}

const seen = new Set<string>()
const tsRegex = /^\uFEFF?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)/

log(`watcher started: blocks=${blocksDir} output=${outputFile}`)

async function poll() {
  try {
    const files = await fs.readdir(blocksDir)
    for (const file of files) {
      if (seen.has(file)) continue

      // Extract step ID from filename: {jobId}_{stepId}.{page}
      const dotIdx = file.lastIndexOf('.')
      const base = dotIdx >= 0 ? file.substring(0, dotIdx) : file
      const underIdx = base.indexOf('_')
      if (underIdx < 0) {
        seen.add(file)
        continue
      }
      const stepId = base.substring(underIdx + 1)

      // Read first line for sub-second timestamp
      try {
        const content = await fs.readFile(path.join(blocksDir, file), 'utf8')
        const firstLine = content.split('\n')[0] || ''
        if (!firstLine) {
          // File exists but is empty — retry next poll (runner hasn't written yet)
          continue
        }
        seen.add(file)
        const match = firstLine.match(tsRegex)
        if (match) {
          log(`timestamp: stepId=${stepId} ts=${match[1]}`)
          await fs.appendFile(outputFile, JSON.stringify({ id: stepId, ts: match[1] }) + '\n')
        } else {
          log(`no timestamp match in ${file}: ${firstLine.substring(0, 80)}`)
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

// Poll every 200ms
setInterval(poll, 200)
poll()
