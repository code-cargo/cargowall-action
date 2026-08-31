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
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({ pid: 4242, unref: vi.fn() })),
}))
vi.mock('fs', () => ({
  openSync: vi.fn(() => 3),
  closeSync: vi.fn(),
  constants: { O_RDONLY: 0, O_NOFOLLOW: 0x100, O_NONBLOCK: 0x800 },
  promises: {
    access: vi.fn(async () => undefined),
    readFile: vi.fn(async () => { throw new Error('ENOENT') }),
    writeFile: vi.fn(async () => undefined),
    open: vi.fn(async () => { throw new Error('ENOENT') }),
    stat: vi.fn(async () => { throw new Error('ENOENT') }),
    lstat: vi.fn(async () => { throw new Error('ENOENT') }),
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
 * Model the state files cargowall writes. Absent paths make fs.access reject
 * and fs.readFile/fs.open/fs.stat throw, matching how the wait loop actually
 * probes them. fs.open returns a minimal FileHandle since the state-file
 * reader uses an O_NOFOLLOW open + bounded read rather than readFile. Present
 * files default to a future mtime (unambiguously fresher than the spawn
 * anchor); pass `mtimes` to model a leftover from a previous run (an old
 * epoch) or a write landing just inside the staleness slack.
 */
function withFiles(files: Record<string, string>, mtimes: Record<string, number> = {}): void {
  vi.mocked(fsp.access).mockImplementation(async (p: unknown) => {
    if (String(p) in files || !String(p).startsWith('/tmp/cargowall')) return undefined
    throw new Error(`ENOENT: ${String(p)}`)
  })
  vi.mocked(fsp.stat).mockImplementation(async (p: unknown) => {
    if (!(String(p) in files)) throw new Error(`ENOENT: ${String(p)}`)
    const mtimeMs = mtimes[String(p)] ?? Date.now() + 5000
    return { mtimeMs, size: 1 } as Awaited<ReturnType<typeof fsp.stat>>
  })
  vi.mocked(fsp.lstat).mockImplementation(async (p: unknown) => {
    if (!(String(p) in files)) throw new Error(`ENOENT: ${String(p)}`)
    return { isFile: () => true } as Awaited<ReturnType<typeof fsp.lstat>>
  })
  vi.mocked(fsp.readFile).mockImplementation(async (p: unknown) => {
    const content = files[String(p)]
    if (content === undefined) throw new Error(`ENOENT: ${String(p)}`)
    return content
  })
  vi.mocked(fsp.open).mockImplementation(async (p: unknown) => {
    const content = files[String(p)]
    if (content === undefined) throw new Error(`ENOENT: ${String(p)}`)
    return {
      stat: async () => ({ isFile: () => true }),
      read: async (buf: Buffer, offset: number, length: number) => {
        const src = Buffer.from(content, 'utf8')
        const bytesRead = src.copy(buf, offset, 0, Math.min(src.length, length))
        return { bytesRead, buffer: buf }
      },
      close: async () => undefined,
    } as unknown as Awaited<ReturnType<typeof fsp.open>>
  })
}

/** Sentinel content exactly as cargowall writes it: pid stamp, then reason. */
function sentinel(reason: string, pid = 4242): string {
  return `pid=${pid}\n${reason}\n`
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

    it('rejects an invalid value even when the API path is disabled', async () => {
      // Validation must not be reachable only on the API path — a typo that
      // lies dormant behind offline:true would surface as a silent posture
      // choice the day the API path is enabled.
      withInputs({ offline: 'true', 'api-failure-mode': 'abort' })
      await expect(start()).rejects.toThrow(/Invalid "api-failure-mode" value "abort"/)
    })
  })

  describe('skip-policy-fetch', () => {
    it('omits the policy-fetch flags while leaving the rest of startup intact', async () => {
      withInputs({ 'api-url': 'https://app.codecargo.com', 'skip-policy-fetch': 'true' })

      const args = await cargowallArgs()

      expect(flag(args, '--api-url')).toBeUndefined()
      expect(flag(args, '--job-key')).toBeUndefined()
      expect(flag(args, '--token')).toBeUndefined()
      expect(flag(args, '--api-failure-mode')).toBeUndefined()
      // Not offline: the audit log still feeds the post-step push, which is
      // the whole point of this input existing next to `offline`.
      expect(flag(args, '--audit-log')).toBe('/tmp/cargowall-audit.json')
    })

    it('passes the policy-fetch flags when left at its default', async () => {
      withInputs({ 'api-url': 'https://app.codecargo.com' })
      expect(flag(await cargowallArgs(), '--api-url')).toBe('https://app.codecargo.com')
    })

    it('still validates api-failure-mode even though it can never apply', async () => {
      withInputs({ 'skip-policy-fetch': 'true', 'api-failure-mode': 'abort' })
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

  describe('v2-preview postures (container-egress / tls-sni)', () => {
    it('passes neither flag by default, so the --github-action preset owns the posture', async () => {
      withInputs({})
      const args = await cargowallArgs()
      expect(args.some(a => a.startsWith('--container-egress'))).toBe(false)
      expect(args.some(a => a.startsWith('--tls-sni'))).toBe(false)
    })

    it('passes the postures a caller asked for', async () => {
      withInputs({ 'container-egress': 'enforce', 'tls-sni': 'enforce-pinned' })
      const args = await cargowallArgs()
      expect(flag(args, '--container-egress')).toBe('enforce')
      expect(flag(args, '--tls-sni')).toBe('enforce-pinned')
    })

    it('passes --tls-sni=observe against the preset hook without naming the hook', async () => {
      withInputs({ 'tls-sni': 'observe' })
      const args = await cargowallArgs()
      expect(flag(args, '--tls-sni')).toBe('observe')
      expect(args.some(a => a.startsWith('--container-egress'))).toBe(false)
    })

    it('notices the experimental enforcement when it can actually drop', async () => {
      withInputs({ 'container-egress': 'enforce' })
      await cargowallArgs()
      expect(core.notice).toHaveBeenCalledWith(
        expect.stringContaining('v2 preview enforcement is ON')
      )
    })

    it('stays silent about enforcement under mode: audit, which defers every drop', async () => {
      withInputs({ mode: 'audit', 'container-egress': 'enforce', 'tls-sni': 'enforce' })
      await cargowallArgs()
      // The step already carries "connections logged but NOT blocked"; a second
      // annotation claiming enforcement would contradict it.
      expect(core.notice).not.toHaveBeenCalledWith(
        expect.stringContaining('v2 preview enforcement')
      )
    })

    it('fails the step before the DNS rewrite when the combination is illegal', async () => {
      withInputs({ 'tls-sni': 'enforce' })
      // Rejected here rather than by the binary: a refused flag never writes a
      // sentinel, so the caller would otherwise get a wait-ready timeout.
      await expect(start()).rejects.toThrow(/requires "container-egress: enforce"/)
      expect(spawn).not.toHaveBeenCalled()
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
      [FAILURE_FILE]: sentinel('cargowall entered policy lockdown (default-deny): policy fetch failed'),
      [DOWNGRADE_FILE]: JSON.stringify({ type: 'CARGO_WALL_DOWNGRADE_TYPE_LOCKDOWN' }),
    })

    // fail-on-unsupported is about eBPF support; api-failure-mode: fail is an
    // explicit request to fail the build, so it must not be overridden by it.
    await expect(start()).rejects.toThrow(/policy lockdown/)
  })

  it('says the runner is still locked down, so the failure is actionable', async () => {
    withInputs({})
    withFiles({
      [FAILURE_FILE]: sentinel('cargowall entered policy lockdown (default-deny): policy fetch failed'),
      [DOWNGRADE_FILE]: JSON.stringify({ type: 'CARGO_WALL_DOWNGRADE_TYPE_LOCKDOWN' }),
    })

    await expect(start()).rejects.toThrow(/locking this runner down to deny-all/)
  })

  it('honours fail-on-unsupported:false for a generic fatal startup error', async () => {
    withInputs({ 'fail-on-unsupported': 'false' })
    withFiles({ [FAILURE_FILE]: sentinel('cargowall startup failed: failed to attach TC program') })

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
    withFiles({ [FAILURE_FILE]: sentinel('cargowall startup failed: failed to attach TC program') })

    await expect(start()).rejects.toThrow(/failed to attach TC program/)
  })

  it('surfaces the binary\'s own reason rather than a generic message', async () => {
    withInputs({ 'fail-on-unsupported': 'true' })
    withFiles({ [FAILURE_FILE]: sentinel('cargowall startup failed: interface eth0 not found') })

    await expect(start()).rejects.toThrow(/interface eth0 not found/)
  })

  it('classifies lockdown from the sentinel text when the downgrade sidecar is missing', async () => {
    withInputs({ 'fail-on-unsupported': 'false' })
    // The downgrade record is best-effort and written AFTER the sentinel. Its
    // absence must not let an explicit fail fall through to the generic path,
    // which would restore DNS under a still-running lockdown and go green.
    withFiles({
      [FAILURE_FILE]: sentinel('cargowall entered policy lockdown (default-deny): policy fetch failed'),
    })

    await expect(start()).rejects.toThrow(/locking this runner down to deny-all/)
  })

  it('ignores a stale failure sentinel left by a previous run', async () => {
    withInputs({})
    // Stale sentinel (mtime long before this spawn) plus a ready file that
    // appears on the second poll — the run must come up clean rather than
    // failing on the leftover.
    withFiles(
      {
        [FAILURE_FILE]: sentinel('cargowall startup failed: crash from a previous run'),
        [READY_FILE]: '',
      },
      { [FAILURE_FILE]: 1 },
    )
    let readyPolls = 0
    const statImpl = vi.mocked(fsp.stat).getMockImplementation()!
    vi.mocked(fsp.stat).mockImplementation(async (p: unknown) => {
      if (String(p) === READY_FILE && readyPolls++ === 0) throw new Error('not yet')
      return statImpl(p as never)
    })

    const result = await start()

    expect(result.supported).toBe(true)
    expect(core.error).not.toHaveBeenCalled()
  }, 10000)

  it('treats a sentinel written moments before the spawn anchor as fresh (slack)', async () => {
    withInputs({ 'fail-on-unsupported': 'true' })
    // Coarse filesystem timestamps or write ordering can put a genuinely
    // fresh sentinel's mtime a hair below spawnedAtMs. Within the slack it
    // must still be trusted — otherwise a fast fatal error loses its precise
    // reason to the generic 30s timeout.
    withFiles(
      { [FAILURE_FILE]: sentinel('cargowall startup failed: eBPF verifier rejected program') },
      { [FAILURE_FILE]: Date.now() - 500 },
    )

    await expect(start()).rejects.toThrow(/eBPF verifier rejected program/)
  })
})
