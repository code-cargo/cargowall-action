import * as core from '@actions/core'
import { postAuditResults } from './audit-push'
import { cleanup } from './cleanup'
import { generateSummary } from './summary'

async function run(): Promise<void> {
  try {
    // Skip if cargowall was never started
    const skipped = core.getState('cargowall-skipped')
    const pid = core.getState('cargowall-pid')

    if (skipped === 'true' && !pid) {
      core.info('CargoWall was not started, skipping cleanup')
      return
    }

    // Generate summary FIRST while cargowall is still running
    // (audit log is synced to disk after every write)
    const auditSummary = core.getInput('audit-summary') !== 'false'
    if (auditSummary) {
      await generateSummary()
    }

    // Push audit results to CodeCargo API if configured
    const apiUrl = core.getInput('api-url')
    if (apiUrl) {
      await postAuditResults(apiUrl)
    }

    // Minimal cleanup — VM destruction handles the rest
    await cleanup()

    core.info('CargoWall cleanup complete')
  } catch (error) {
    // Post step should not fail the workflow
    if (error instanceof Error) {
      core.warning(`CargoWall cleanup error: ${error.message}`)
    } else {
      core.warning(`CargoWall cleanup error: ${error}`)
    }
  }
}

run()
