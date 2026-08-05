import * as core from '@actions/core'
import { promises as fs } from 'fs'
import { cleanup } from './cleanup'
import { STALE_SLACK_MS } from './start'
import { generateSummary } from './summary'

// Shared with start.ts and the Go binary — see start.ts for the contract.
const DOWNGRADE_FILE = '/tmp/cargowall-downgrade'

async function run(): Promise<void> {
  try {
    // Skip if cargowall was never started
    const skipped = core.getState('cargowall-skipped')
    const pid = core.getState('cargowall-pid')

    if (skipped === 'true' && !pid) {
      core.info('CargoWall was not started, skipping cleanup')
      return
    }

    // The summary/push only means something when cargowall actually ran (pid
    // state saved on the ready path) or recorded a posture change worth
    // reporting — policy lockdown writes the downgrade record and the push
    // carries it to the dashboard. If start() failed before either — bad
    // input, failed download, spawn failure, crash, timeout — a zero-event
    // push would report effective mode "enforce" for a job that had no
    // filtering at all, and spend an Actions API request doing it.
    //
    // The downgrade record is anchored on the spawn time saved by start(),
    // like every state-file reader there: clearStartupFiles' rm is
    // best-effort, so a leftover record from a previous job on a reused
    // runner must not count as this run's. Absent state means cargowall was
    // never even spawned — any record is definitionally not this run's.
    const spawnedAtMs = Number(core.getState('cargowall-spawned-at'))
    let downgraded = false
    if (spawnedAtMs > 0) {
      try {
        downgraded = (await fs.stat(DOWNGRADE_FILE)).mtimeMs >= spawnedAtMs - STALE_SLACK_MS
      } catch {
        // No downgrade record — the common case.
      }
    }
    if (!pid && !downgraded) {
      core.info('CargoWall never ran in this job, skipping summary')
      await cleanup()
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
