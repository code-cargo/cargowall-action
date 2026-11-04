import * as core from '@actions/core'
import { promises as fs } from 'fs'
import { cleanup } from './cleanup'
import { readStateFile, sentinelReason, sentinelRefusal, STALE_SLACK_MS } from './start'
import { generateSummary } from './summary'

// Shared with start.ts and the Go binary — see start.ts for the contract.
const DOWNGRADE_FILE = '/tmp/cargowall-downgrade'
const FAILURE_FILE = '/tmp/cargowall-failed'

async function run(): Promise<void> {
  await report()
  await failOnLateRefusal()
}

async function report(): Promise<void> {
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
    // Post step should not fail the workflow over its own errors; only a
    // refusal does (failOnLateRefusal).
    if (error instanceof Error) {
      core.warning(`CargoWall cleanup error: ${error.message}`)
    } else {
      core.warning(`CargoWall cleanup error: ${error}`)
    }
  }
}

/**
 * Fails the job for a posture cargowall refused after the start step had
 * passed. Once ready, cargowall can still find that a layer the job asked to
 * enforce doesn't reach what it promised: container-egress, when a Docker
 * daemon still starting at startup answers with its containers outside the
 * hook's scope. It names the posture in the failure sentinel, as a refused
 * startup does (see sentinelRefusal), but the start step that reads it has
 * long returned, so this step fails the job in its place. Only this run's
 * sentinel counts: the start step saved a pid, which it does only once
 * cargowall is ready (a refused startup failed that step already), and the
 * sentinel is no older than the spawn. It runs after the summary, which shows
 * the refused posture, and whether or not that succeeded.
 */
async function failOnLateRefusal(): Promise<void> {
  const spawnedAtMs = Number(core.getState('cargowall-spawned-at'))
  if (!core.getState('cargowall-pid') || !(spawnedAtMs > 0)) return
  try {
    if ((await fs.stat(FAILURE_FILE)).mtimeMs < spawnedAtMs - STALE_SLACK_MS) return
  } catch {
    return // No failure sentinel: the common case.
  }
  const raw = await readStateFile(FAILURE_FILE)
  const posture = raw === null ? null : sentinelRefusal(raw)
  if (raw === null || posture === null) return
  core.setFailed(
    `CargoWall refused --${posture} after the start step had passed: ${sentinelReason(raw)}. ` +
      'The job ran without all of the enforcement it asked for from then on, so this step fails it, ' +
      'as a refused startup would have.'
  )
}

run()
