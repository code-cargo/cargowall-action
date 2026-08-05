import * as core from '@actions/core'
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

    // Run the summary FIRST while cargowall is still running
    // (audit log is synced to disk after every write).
    //
    // `cargowall summary` both renders the markdown and performs the SaaS push,
    // so `audit-summary` may only suppress the rendering — gating the whole
    // invocation on it made those jobs invisible to the dashboard, downgrade
    // records included (#71). Skip entirely only when there is nothing to do:
    // no rendering wanted and no API to push to.
    const render = core.getInput('audit-summary') !== 'false'
    const canPush = !!core.getInput('api-url') && core.getInput('offline') !== 'true'
    if (render || canPush) {
      await generateSummary({ render })
    } else {
      core.info('Audit summary disabled and API push not configured, skipping summary')
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
