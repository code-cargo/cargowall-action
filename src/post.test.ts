import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * #71: `audit-summary` must gate *rendering only*. `cargowall summary` is also
 * the SaaS push, so skipping the invocation made those jobs invisible to the
 * dashboard — no job record, no effective mode, no downgrade record.
 */

vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  getState: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  setFailed: vi.fn(),
}))
vi.mock('./cleanup', () => ({ cleanup: vi.fn() }))
vi.mock('./summary', () => ({ generateSummary: vi.fn() }))
vi.mock('fs', () => ({
  promises: {
    // No downgrade record by default — the common case.
    stat: vi.fn(async () => { throw new Error('ENOENT') }),
  },
}))
vi.mock('./start', async importOriginal => {
  const actual = await importOriginal<typeof import('./start')>()
  return {
    STALE_SLACK_MS: 2000,
    readStateFile: vi.fn(async () => null),
    // start.ts's tests cover its freshness and owner checks; these pin what
    // post.ts asks of it.
    readFreshStateFile: vi.fn(async () => null),
    sentinelReason: actual.sentinelReason,
    sentinelRefusal: actual.sentinelRefusal,
  }
})

import * as core from '@actions/core'
import { promises as fsp } from 'fs'
import { cleanup } from './cleanup'
import { readFreshStateFile, readStateFile } from './start'
import { generateSummary } from './summary'

const DOWNGRADE_FILE = '/tmp/cargowall-downgrade'

/** post.ts invokes run() on import, so re-import it fresh to drive each path. */
async function runPost(): Promise<void> {
  vi.resetModules()
  await import('./post')
  await vi.waitFor(() => {
    expect(vi.mocked(cleanup)).toHaveBeenCalled()
  })
}

function withInputs(inputs: Record<string, string>): void {
  vi.mocked(core.getInput).mockImplementation((name: string) => inputs[name] ?? '')
}

/** State as start() leaves it on the happy path: pid saved, spawn anchor saved. */
function withState(state: Record<string, string>): void {
  vi.mocked(core.getState).mockImplementation((name: string) => state[name] ?? '')
}

describe('post', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // cargowall started, so the post step does its full job.
    withState({ 'cargowall-pid': '4242', 'cargowall-spawned-at': String(Date.now() - 60_000) })
    vi.mocked(fsp.stat).mockRejectedValue(new Error('ENOENT'))
    vi.mocked(readFreshStateFile).mockResolvedValue(null)
    withInputs({})
  })

  it('renders and pushes by default', async () => {
    withInputs({ 'api-url': 'https://app.codecargo.com' })
    await runPost()
    expect(generateSummary).toHaveBeenCalledWith({ render: true })
  })

  it('still runs the summary with audit-summary:false when the API is configured', async () => {
    withInputs({ 'audit-summary': 'false', 'api-url': 'https://app.codecargo.com' })

    await runPost()

    // The push lives inside this invocation — skipping it is the #71 bug.
    expect(generateSummary).toHaveBeenCalledWith({ render: false })
  })

  it('renders when audit-summary is on even with no API configured', async () => {
    withInputs({ 'api-url': '' })
    await runPost()
    expect(generateSummary).toHaveBeenCalledWith({ render: true })
  })

  it('skips entirely when there is nothing to render and nothing to push', async () => {
    withInputs({ 'audit-summary': 'false', 'api-url': '' })
    await runPost()
    expect(generateSummary).not.toHaveBeenCalled()
  })

  it('treats offline as nothing to push, so audit-summary:false skips entirely', async () => {
    withInputs({
      'audit-summary': 'false',
      'api-url': 'https://app.codecargo.com',
      offline: 'true',
    })

    await runPost()

    expect(generateSummary).not.toHaveBeenCalled()
  })

  it('still pushes when offline is set to anything other than the literal "true"', async () => {
    withInputs({
      'audit-summary': 'false',
      'api-url': 'https://app.codecargo.com',
      offline: 'false',
    })

    await runPost()

    expect(generateSummary).toHaveBeenCalledWith({ render: false })
  })

  it('does nothing when cargowall was never started', async () => {
    vi.mocked(core.getState).mockImplementation((name: string) =>
      name === 'cargowall-skipped' ? 'true' : ''
    )
    withInputs({ 'api-url': 'https://app.codecargo.com' })

    vi.resetModules()
    await import('./post')
    await vi.waitFor(() => expect(core.info).toHaveBeenCalled())

    expect(generateSummary).not.toHaveBeenCalled()
    expect(cleanup).not.toHaveBeenCalled()
  })

  it('skips the push when start() failed before cargowall ran', async () => {
    // start() threw pre-spawn (bad input, download failure): no pid state, no
    // downgrade record. A zero-event push would report effective mode
    // "enforce" for a job that had no filtering at all.
    withState({})
    withInputs({ 'api-url': 'https://app.codecargo.com' })

    await runPost()

    expect(generateSummary).not.toHaveBeenCalled()
    expect(cleanup).toHaveBeenCalled()
  })

  it('still pushes for a policy lockdown (fresh downgrade record, no pid)', async () => {
    // Lockdown never saves pid state (the throw happens before), but the
    // downgrade record exists and the push carries it to the dashboard.
    const spawnedAt = Date.now() - 60_000
    withState({ 'cargowall-spawned-at': String(spawnedAt) })
    vi.mocked(readFreshStateFile).mockImplementation(async path =>
      path === DOWNGRADE_FILE ? 'policy-lockdown\n' : null
    )
    withInputs({ 'api-url': 'https://app.codecargo.com' })

    await runPost()

    expect(readFreshStateFile).toHaveBeenCalledWith(DOWNGRADE_FILE, spawnedAt)
    expect(generateSummary).toHaveBeenCalledWith({ render: true })
  })

  it("ignores a downgrade record that isn't this run's cargowall's (stale, or not root-owned)", async () => {
    // Its mtime alone reads as fresh, but readFreshStateFile rejects it: a
    // leftover from a previous job, or a file root does not own. Counting it
    // pushed a zero-event record for a job where cargowall never ran.
    withState({ 'cargowall-spawned-at': String(Date.now() - 60_000) })
    vi.mocked(fsp.stat).mockResolvedValue({ mtimeMs: Date.now() } as Awaited<ReturnType<typeof fsp.stat>>)
    withInputs({ 'api-url': 'https://app.codecargo.com' })

    await runPost()

    expect(readFreshStateFile).toHaveBeenCalledWith(DOWNGRADE_FILE, expect.any(Number))
    expect(generateSummary).not.toHaveBeenCalled()
    expect(core.info).toHaveBeenCalledWith('CargoWall never ran in this job, skipping summary')
    expect(cleanup).toHaveBeenCalled()
  })

  it('ignores a downgrade record entirely when cargowall was never spawned', async () => {
    // No spawn anchor ⇒ start() threw before spawning ⇒ any record on disk is
    // definitionally from a previous job.
    withState({})
    vi.mocked(readFreshStateFile).mockResolvedValue('policy-lockdown\n')
    withInputs({ 'api-url': 'https://app.codecargo.com' })

    await runPost()

    expect(readFreshStateFile).not.toHaveBeenCalled()
    expect(generateSummary).not.toHaveBeenCalled()
  })
})

/**
 * A posture cargowall refused after it was ready fails the job here: the
 * start step that reads the failure sentinel has long returned.
 */
describe('post: a refusal decided after startup', () => {
  const FAILURE_FILE = '/tmp/cargowall-failed'
  const lateSentinel =
    'pid=4242\nrefused=container-egress\ncargowall: --container-egress=enforce requested but could not be ' +
    'applied, decided after startup: once Docker answered: its runtime is outside the hook\'s scope\n'

  /** A failure sentinel written mtimeMs, and no downgrade record. */
  function withSentinel(raw: string, mtimeMs: number): void {
    vi.mocked(fsp.stat).mockImplementation(async path => {
      if (path === FAILURE_FILE) return { mtimeMs } as Awaited<ReturnType<typeof fsp.stat>>
      throw new Error('ENOENT')
    })
    vi.mocked(readStateFile).mockImplementation(async path => (path === FAILURE_FILE ? raw : null))
  }

  /** Lets run() finish what it does after cleanup. */
  const settle = () => new Promise(resolve => setTimeout(resolve, 20))

  beforeEach(() => {
    vi.clearAllMocks()
    withState({ 'cargowall-pid': '4242', 'cargowall-spawned-at': String(Date.now() - 60_000) })
    withInputs({ 'api-url': 'https://app.codecargo.com' })
    vi.mocked(generateSummary).mockResolvedValue(undefined)
    vi.mocked(readFreshStateFile).mockResolvedValue(null)
  })

  it('fails the job, after the summary that shows it', async () => {
    withSentinel(lateSentinel, Date.now())
    await runPost()
    await vi.waitFor(() => expect(core.setFailed).toHaveBeenCalledTimes(1))
    const msg = vi.mocked(core.setFailed).mock.calls[0][0] as string
    expect(msg).toContain('CargoWall refused --container-egress mid-job: --container-egress=enforce requested')
    expect(msg).toContain('once Docker answered')
    expect(msg).not.toContain('cargowall: ')
    expect(vi.mocked(generateSummary).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(core.setFailed).mock.invocationCallOrder[0])
  })

  it('fails the job even when the summary errors', async () => {
    withSentinel(lateSentinel, Date.now())
    vi.mocked(generateSummary).mockRejectedValue(new Error('push failed'))
    vi.resetModules()
    await import('./post')
    await vi.waitFor(() => expect(core.setFailed).toHaveBeenCalledTimes(1))
    expect(core.warning).toHaveBeenCalledWith('CargoWall cleanup error: push failed')
  })

  it('counts a sentinel stamped just before the spawn anchor, within the clock slack', async () => {
    const spawnedAt = Date.now()
    withState({ 'cargowall-pid': '4242', 'cargowall-spawned-at': String(spawnedAt) })
    withSentinel(lateSentinel, spawnedAt - 1000)
    await runPost()
    await vi.waitFor(() => expect(core.setFailed).toHaveBeenCalledTimes(1))
  })

  it('ignores a sentinel with no spawn anchor to judge its age by', async () => {
    withState({ 'cargowall-pid': '4242' })
    withSentinel(lateSentinel, Date.now())
    await runPost()
    await settle()
    expect(readStateFile).not.toHaveBeenCalled()
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('ignores a sentinel from a previous job on a reused runner', async () => {
    withSentinel(lateSentinel, Date.now() - 3_600_000)
    await runPost()
    await settle()
    expect(readStateFile).not.toHaveBeenCalled()
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('ignores a failure that names no refused posture', async () => {
    withSentinel('pid=4242\ncargowall startup failed: boom\n', Date.now())
    await runPost()
    await settle()
    expect(readStateFile).toHaveBeenCalledWith(FAILURE_FILE)
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('leaves a refused startup to the start step', async () => {
    // A startup refusal never reaches ready, so no pid is saved, and the
    // start step has failed already: failing again would only repeat it.
    withState({ 'cargowall-spawned-at': String(Date.now() - 60_000) })
    withSentinel(lateSentinel.replace('decided after startup: ', ''), Date.now())
    await runPost()
    await settle()
    expect(readStateFile).not.toHaveBeenCalled()
    expect(core.setFailed).not.toHaveBeenCalled()
  })
})
