import { describe, it, expect, vi } from 'vitest'

vi.mock('@actions/core', () => ({}))
vi.mock('@actions/exec', () => ({}))
vi.mock('@actions/tool-cache', () => ({}))

import { CARGOWALL_VERSION } from './setup'
import {
  EXIT_REFUSED,
  STARTUP_BOUNDS,
  enforcingRungRequested,
  STARTUP_BOUNDS_CHECKED_AGAINST,
  STARTUP_BOUNDS_SECONDS,
  STARTUP_TIMEOUT,
  waitForReady,
  type Liveness,
  type WaitProbes,
} from './startup'

/**
 * A scripted cargowall: each probe answers from what has happened by the
 * fake clock's second. The clock only moves when the wait sleeps.
 */
function scripted(opts: {
  readyAt?: number
  failureAt?: number
  pidAt?: number
  deadAt?: number
  exit?: { at: number; code: number | null }
}): WaitProbes<string> & { sleeps: number[] } {
  let now = 0
  const at = (t?: number) => t !== undefined && now >= t * 1000
  const sleeps: number[] = []
  return {
    sleeps,
    ready: async () => at(opts.readyAt),
    failure: async () => (at(opts.failureAt) ? 'boom' : null),
    pid: async () => (at(opts.pidAt) ? 4243 : null),
    liveness: async (): Promise<Liveness> => (at(opts.deadAt) ? 'dead' : 'alive'),
    exitCode: () => (opts.exit && at(opts.exit.at) ? opts.exit.code : null),
    now: () => now,
    sleep: async ms => {
      sleeps.push(ms)
      now += ms
    },
  }
}

describe('waitForReady', () => {
  it('ends ready when the sentinel appears, with the pid it read', async () => {
    const p = scripted({ pidAt: 1, readyAt: 150 })
    expect(await waitForReady(p, 0)).toEqual({ kind: 'ready', pid: 4243 })
  })

  it('ends on the failure sentinel at once', async () => {
    const p = scripted({ failureAt: 2 })
    expect(await waitForReady(p, 0)).toEqual({ kind: 'failed', failure: 'boom' })
    expect(p.sleeps).toHaveLength(2)
  })

  it('ends on exit status 3 with no sentinel', async () => {
    expect(await waitForReady(scripted({ exit: { at: 1, code: EXIT_REFUSED } }), 0)).toEqual({ kind: 'refused' })
  })

  it('ends when cargowall, its pid read, has died', async () => {
    expect(await waitForReady(scripted({ pidAt: 1, deadAt: 5 }), 0)).toEqual({ kind: 'died', pid: 4243 })
  })

  // A flag the binary rejects, a sudo or exec failure: the launcher exits
  // with a status before cargowall ever wrote its pidfile.
  it('ends at once on a launcher that exited with a status before any pidfile', async () => {
    const p = scripted({ exit: { at: 0, code: 80 } })
    expect(await waitForReady(p, 0)).toEqual({ kind: 'launcher-exited', code: 80 })
    expect(p.sleeps).toHaveLength(0)
  })

  // Exit status 3 that lands after the refusal check, during the pid read,
  // is still a refusal, never an ordinary launcher exit.
  it('takes a status 3 that lands mid-poll as a refusal', async () => {
    let calls = 0
    const p = scripted({})
    p.exitCode = () => (++calls > 1 ? EXIT_REFUSED : null)
    expect(await waitForReady(p, 0)).toEqual({ kind: 'refused' })
  })

  // Under the sudo lockdown liveness is unknown: a launcher that exited with
  // a status then ends the wait, though a pidfile was seen.
  it('ends on a launcher status exit once a pidfile was seen but liveness is unknown', async () => {
    const p = scripted({ pidAt: 1, exit: { at: 3, code: 2 } })
    p.liveness = async () => 'unknown'
    expect(await waitForReady(p, 0)).toEqual({ kind: 'launcher-exited', code: 2 })
    expect(p.sleeps.length).toBeLessThan(5)
  })

  // Under the sudo lockdown every liveness probe is a denied sudo: once one
  // answers unknown, no more are made.
  it('stops probing liveness once it is unknown', async () => {
    const p = scripted({ pidAt: 0, readyAt: 100 })
    let probes = 0
    p.liveness = async () => {
      probes++
      return 'unknown'
    }
    expect(await waitForReady(p, 0)).toEqual({ kind: 'ready', pid: 4243 })
    expect(probes).toBe(1)
  })

  it('prefers a sentinel that lands as the launcher exits', async () => {
    const p = scripted({ exit: { at: 0, code: 1 }, failureAt: 0 })
    expect(await waitForReady(p, 0)).toEqual({ kind: 'failed', failure: 'boom' })
  })

  // The Docker restart can tear down the launcher's process tree: a signal,
  // no status. The wait goes on, and so it does once a pidfile was seen.
  it('keeps waiting on a launcher killed by a signal, or one that exits after the pidfile', async () => {
    expect(await waitForReady(scripted({ exit: { at: 1, code: null }, readyAt: 30 }), 0)).toEqual({ kind: 'ready', pid: null })
    expect(await waitForReady(scripted({ pidAt: 1, exit: { at: 2, code: 0 }, readyAt: 30 }), 0)).toEqual({
      kind: 'ready',
      pid: 4243,
    })
  })

  it('times out on the wall clock, not by counting polls', async () => {
    // Every poll costs a second of probes on top of its sleep.
    let now = 0
    let polls = 0
    const p: WaitProbes<string> = {
      ready: async () => false,
      failure: async () => null,
      pid: async () => 4243,
      liveness: async () => {
        polls++
        now += 1000
        return 'alive'
      },
      exitCode: () => null,
      now: () => now,
      sleep: async ms => {
        now += ms
      },
    }
    const out = await waitForReady(p, 0, 10_000)
    expect(out.kind).toBe('timeout')
    expect(out.kind === 'timeout' && out.waitedMs).toBeGreaterThanOrEqual(10_000)
    expect(out.kind === 'timeout' && out.waitedMs).toBeLessThan(12_000)
    expect(polls).toBeLessThan(10)
  })

  it('times out after STARTUP_TIMEOUT seconds by default', async () => {
    const out = await waitForReady(scripted({}), 0)
    expect(out).toEqual({ kind: 'timeout', pid: null, waitedMs: STARTUP_TIMEOUT * 1000 })
  })
})

describe('STARTUP_TIMEOUT', () => {
  // src/startup.ts sums the pinned cargowall's bounded waits on its way to
  // ready. A pin bump that leaves it unchecked could leave the action giving
  // up on a cargowall still inside its own limits, and with
  // fail-on-unsupported: false running the job unfiltered.
  it('was checked against the pinned cargowall: recheck the sum in startup.ts, then move STARTUP_BOUNDS_CHECKED_AGAINST', () => {
    expect(STARTUP_BOUNDS_CHECKED_AGAINST).toBe(CARGOWALL_VERSION)
  })

  it('is the itemised bounds summed, and half again', () => {
    expect(STARTUP_BOUNDS_SECONDS).toBe(STARTUP_BOUNDS.reduce((s, b) => s + b.seconds, 0))
    expect(STARTUP_BOUNDS_SECONDS).toBe(162)
    expect(STARTUP_TIMEOUT).toBeGreaterThanOrEqual(STARTUP_BOUNDS_SECONDS * 1.5)
  })
})

describe('enforcingRungRequested', () => {
  it('is an enforcing rung under an enforcing mode, and only that', () => {
    expect(enforcingRungRequested(['--container-egress=enforce'], 'enforce')).toBe(true)
    expect(enforcingRungRequested(['--container-egress=enforce', '--tls-sni=enforce-pinned'], 'enforce')).toBe(true)
    expect(enforcingRungRequested(['--container-egress=observe', '--tls-sni=observe'], 'enforce')).toBe(false)
    expect(enforcingRungRequested(['--container-egress=enforce'], 'audit')).toBe(false)
    expect(enforcingRungRequested([], 'enforce')).toBe(false)
  })
})
