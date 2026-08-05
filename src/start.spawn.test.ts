import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Covers the arguments `start()` actually hands the cargowall binary.
 *
 * This is the regression surface for both #69 (policy-fetch posture) and #71
 * (audit-summary must not gate event collection): the resolution logic is unit
 * tested elsewhere, but nothing else proves the resolved value reaches the
 * command line, or that a flag dropped on one path is dropped on all of them.
 *
 * Lives in its own file because it needs the whole module graph mocked, while
 * start.test.ts deliberately mocks only `getMultilineInput`.
 */

vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  getMultilineInput: vi.fn(() => []),
  getIDToken: vi.fn(),
  startGroup: vi.fn(),
  endGroup: vi.fn(),
  info: vi.fn(),
  notice: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  saveState: vi.fn(),
  setOutput: vi.fn(),
}))
vi.mock('@actions/exec', () => ({ exec: vi.fn(async () => 0) }))
vi.mock('@actions/github', () => ({ context: { job: 'build' } }))
vi.mock('./dns', () => ({
  detectDnsUpstream: vi.fn(async () => ({ primary: '10.0.0.1:53' })),
}))
// No _diag dir → no watcher spawn, so the only spawn() call is cargowall itself.
vi.mock('./diag', () => ({
  findDiagDir: vi.fn(async () => null),
  parseJobPlan: vi.fn(async () => ({})),
  parseExecutedSteps: vi.fn(async () => []),
}))
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({ pid: 4242, unref: vi.fn() })),
}))
vi.mock('fs', () => ({
  openSync: vi.fn(() => 3),
  closeSync: vi.fn(),
  promises: {
    access: vi.fn(async () => undefined),
    readFile: vi.fn(async () => { throw new Error('ENOENT') }),
    writeFile: vi.fn(async () => undefined),
  },
}))

import * as core from '@actions/core'
import { promises as fsp } from 'fs'
import { spawn } from 'child_process'
import { start } from './start'

const READY_FILE = '/tmp/cargowall-ready'
const FAILURE_FILE = '/tmp/cargowall-failed'
const DOWNGRADE_FILE = '/tmp/cargowall-downgrade'

/**
 * Model the state files cargowall writes. `absent` paths make fs.access reject
 * and fs.readFile throw, matching how the wait loop actually probes them.
 */
function withFiles(files: Record<string, string>): void {
  vi.mocked(fsp.access).mockImplementation(async (p: unknown) => {
    if (String(p) in files || !String(p).startsWith('/tmp/cargowall')) return undefined
    throw new Error(`ENOENT: ${String(p)}`)
  })
  vi.mocked(fsp.readFile).mockImplementation(async (p: unknown) => {
    const content = files[String(p)]
    if (content === undefined) throw new Error(`ENOENT: ${String(p)}`)
    return content
  })
}

/**
 * The two auto-allow host lists carry non-empty defaults in action.yml, which
 * the runner materialises for us — requireNonEmptyHostList treats an empty
 * result as a deliberate clear and throws. Mirror the runner so tests exercise
 * the real path rather than that guard.
 */
const HOST_LIST_DEFAULTS: Record<string, string[]> = {
  'github-service-hosts': ['github.com', 'api.github.com'],
  'azure-infra-hosts': ['trafficmanager.net'],
}

/** Inputs not named by a test fall back to '' — i.e. "caller said nothing". */
function withInputs(inputs: Record<string, string>): void {
  vi.mocked(core.getInput).mockImplementation((name: string) => inputs[name] ?? '')
}

/** The argv handed to the cargowall binary (spawn is `sudo -E cargowall …`). */
async function cargowallArgs(): Promise<string[]> {
  await start()
  const call = vi.mocked(spawn).mock.calls.at(-1)
  if (!call) throw new Error('cargowall was never spawned')
  return call[1] as string[]
}

/** Value of a `--flag=value` argument, or undefined when the flag is absent. */
function flag(args: string[], name: string): string | undefined {
  return args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1)
}

describe('start() argument construction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(core.getMultilineInput).mockImplementation(
      (name: string) => HOST_LIST_DEFAULTS[name] ?? []
    )
    vi.mocked(core.getIDToken).mockResolvedValue('oidc-token')
    vi.mocked(core.getInput).mockReturnValue('')
    // Ready sentinel already present, so the wait loop exits on iteration 0.
    withFiles({ [READY_FILE]: '' })
  })

  describe('audit log collection (#71)', () => {
    it('passes --audit-log even when audit-summary is false', async () => {
      withInputs({ 'audit-summary': 'false' })
      // Gating collection on a rendering preference is exactly the bug: it left
      // audit-summary:false jobs with no events and no dashboard record.
      expect(flag(await cargowallArgs(), '--audit-log')).toBe('/tmp/cargowall-audit.json')
    })

    it('passes --audit-log when audit-summary is left at its default', async () => {
      withInputs({})
      expect(flag(await cargowallArgs(), '--audit-log')).toBe('/tmp/cargowall-audit.json')
    })
  })

  describe('failure sentinel', () => {
    it('pins --failure-file so the wait loop and the binary agree on the path', async () => {
      withInputs({})
      expect(flag(await cargowallArgs(), '--failure-file')).toBe('/tmp/cargowall-failed')
    })
  })

  describe('--api-failure-mode (#69)', () => {
    it('defaults to audit when neither mode nor api-failure-mode is given', async () => {
      withInputs({ 'api-url': 'https://app.codecargo.com' })
      expect(flag(await cargowallArgs(), '--api-failure-mode')).toBe('audit')
    })

    it('defers to an explicitly set mode', async () => {
      withInputs({ 'api-url': 'https://app.codecargo.com', mode: 'enforce' })
      expect(flag(await cargowallArgs(), '--api-failure-mode')).toBe('local')
    })

    it('does not treat an invalid mode as explicitly set', async () => {
      withInputs({ 'api-url': 'https://app.codecargo.com', mode: 'bogus' })

      const args = await cargowallArgs()

      // A typo'd mode falls back to enforce as a lenient recovery, not a user
      // instruction — so the audit default must still apply on API outages.
      expect(flag(args, '--api-failure-mode')).toBe('audit')
      expect(args).not.toContain('--audit-mode')
      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Invalid mode "bogus"'))
    })

    it('translates the public "enforce" spelling to cargowall\'s "local"', async () => {
      withInputs({ 'api-url': 'https://app.codecargo.com', 'api-failure-mode': 'enforce' })
      expect(flag(await cargowallArgs(), '--api-failure-mode')).toBe('local')
    })

    it('passes fail through', async () => {
      withInputs({ 'api-url': 'https://app.codecargo.com', 'api-failure-mode': 'fail' })
      expect(flag(await cargowallArgs(), '--api-failure-mode')).toBe('fail')
    })

    it('lets an explicit api-failure-mode beat an explicit mode', async () => {
      withInputs({
        'api-url': 'https://app.codecargo.com',
        mode: 'enforce',
        'api-failure-mode': 'audit',
      })
      expect(flag(await cargowallArgs(), '--api-failure-mode')).toBe('audit')
    })

    it('omits the flag entirely when offline', async () => {
      withInputs({ 'api-url': 'https://app.codecargo.com', offline: 'true' })
      const args = await cargowallArgs()
      expect(flag(args, '--api-failure-mode')).toBeUndefined()
      expect(flag(args, '--api-url')).toBeUndefined()
    })

    it('omits the flag entirely when no api-url is configured', async () => {
      withInputs({ 'api-url': '' })
      expect(flag(await cargowallArgs(), '--api-failure-mode')).toBeUndefined()
    })

    it('drops the flag with the rest of the API args when the OIDC token is unavailable', async () => {
      withInputs({ 'api-url': 'https://app.codecargo.com', 'api-failure-mode': 'fail' })
      vi.mocked(core.getIDToken).mockRejectedValue(new Error('no id-token permission'))

      const args = await cargowallArgs()

      // No token means no fetch is attempted, so there is no retrieval failure
      // to act on. Leaving --api-failure-mode=fail behind would lock the runner
      // down over a missing workflow permission.
      expect(flag(args, '--api-failure-mode')).toBeUndefined()
      expect(flag(args, '--api-url')).toBeUndefined()
      expect(flag(args, '--job-key')).toBeUndefined()
      expect(flag(args, '--token')).toBeUndefined()
    })

    it('fails the step on an invalid value instead of picking a posture', async () => {
      withInputs({ 'api-url': 'https://app.codecargo.com', 'api-failure-mode': 'abort' })
      await expect(start()).rejects.toThrow(/Invalid "api-failure-mode" value "abort"/)
    })
  })

  describe('mode', () => {
    it('passes --audit-mode when mode is audit', async () => {
      withInputs({ mode: 'audit' })
      expect(await cargowallArgs()).toContain('--audit-mode')
    })

    it('omits --audit-mode by default, since the default is enforce', async () => {
      withInputs({})
      expect(await cargowallArgs()).not.toContain('--audit-mode')
    })
  })

  describe('posture downgrade reporting', () => {
    it('warns when cargowall recorded an audit fallback', async () => {
      withInputs({})
      withFiles({
        [READY_FILE]: '',
        [DOWNGRADE_FILE]: JSON.stringify({
          type: 'CARGO_WALL_DOWNGRADE_TYPE_AUDIT_FALLBACK',
          detail: 'downgraded to audit mode: policy could not be retrieved',
        }),
      })

      await start()

      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('downgraded to audit mode: policy could not be retrieved')
      )
    })

    it('stays quiet on a normal run', async () => {
      withInputs({})
      await start()
      expect(core.warning).not.toHaveBeenCalled()
    })
  })
})

/**
 * The failure sentinel is shared by policy lockdown and any fatal startup
 * error, and the two need opposite handling. Getting this wrong either fails
 * builds that `fail-on-unsupported: false` says to warn-and-continue on, or
 * lets a lockdown pass as a success.
 */
describe('start() failure-sentinel handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(core.getMultilineInput).mockImplementation(
      (name: string) => HOST_LIST_DEFAULTS[name] ?? []
    )
    vi.mocked(core.getIDToken).mockResolvedValue('oidc-token')
    vi.mocked(core.getInput).mockReturnValue('')
  })

  it('fails the step on policy lockdown, even with fail-on-unsupported false', async () => {
    withInputs({ 'fail-on-unsupported': 'false' })
    withFiles({
      // No ready sentinel: in lockdown cargowall deliberately withholds it.
      [FAILURE_FILE]: 'cargowall entered policy lockdown (default-deny): policy fetch failed',
      [DOWNGRADE_FILE]: JSON.stringify({ type: 'CARGO_WALL_DOWNGRADE_TYPE_LOCKDOWN' }),
    })

    // fail-on-unsupported is about eBPF support; api-failure-mode: fail is an
    // explicit request to fail the build, so it must not be overridden by it.
    await expect(start()).rejects.toThrow(/policy lockdown/)
  })

  it('says the runner is still locked down, so the failure is actionable', async () => {
    withInputs({})
    withFiles({
      [FAILURE_FILE]: 'cargowall entered policy lockdown (default-deny): policy fetch failed',
      [DOWNGRADE_FILE]: JSON.stringify({ type: 'CARGO_WALL_DOWNGRADE_TYPE_LOCKDOWN' }),
    })

    await expect(start()).rejects.toThrow(/holding this runner at deny-all/)
  })

  it('honours fail-on-unsupported:false for a generic fatal startup error', async () => {
    withInputs({ 'fail-on-unsupported': 'false' })
    withFiles({ [FAILURE_FILE]: 'cargowall startup failed: failed to attach TC program' })

    // No downgrade record → not a lockdown → the pre-existing contract applies.
    const result = await start()

    expect(result).toEqual({ supported: false, pid: null })
    expect(core.setOutput).toHaveBeenCalledWith('supported', 'false')
    // Pins this to the sentinel branch: the 30s-timeout path returns the same
    // shape, but carries a generic message instead of the binary's reason.
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('failed to attach TC program')
    )
  })

  it('fails a generic fatal startup error when fail-on-unsupported is true', async () => {
    withInputs({ 'fail-on-unsupported': 'true' })
    withFiles({ [FAILURE_FILE]: 'cargowall startup failed: failed to attach TC program' })

    await expect(start()).rejects.toThrow(/failed to attach TC program/)
  })

  it('surfaces the binary\'s own reason rather than a generic message', async () => {
    withInputs({ 'fail-on-unsupported': 'true' })
    withFiles({ [FAILURE_FILE]: 'cargowall startup failed: interface eth0 not found' })

    await expect(start()).rejects.toThrow(/interface eth0 not found/)
  })
})
