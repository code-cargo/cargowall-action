import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The environment `start()` hands cargowall through sudo: the allowlist of
 * src/env.ts, the names --preserve-env carries, and the sudo it spawns,
 * found before DNS is touched. Its own file because start.spawn.test.ts is
 * at the size limit; the mocks are the same shape as there.
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
vi.mock('@actions/io', () => ({ which: vi.fn(async () => '/usr/bin/sudo') }))
vi.mock('@actions/exec', () => ({ exec: vi.fn(async () => 0) }))
vi.mock('@actions/github', () => ({ context: { job: 'build' } }))
// Only the detection is stubbed: proxyResolvConf stays real so these tests
// assert the document that actually lands in /etc/resolv.conf.
vi.mock('./dns', async importOriginal => ({
  ...(await importOriginal<typeof import('./dns')>()),
  detectDnsUpstream: vi.fn(async () => ({ primary: '10.0.0.1:53' })),
}))
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({ pid: 4242, unref: vi.fn(), on: vi.fn() })),
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
import * as exec from '@actions/exec'
import { promises as fsp } from 'fs'
import { spawn } from 'child_process'
import * as io from '@actions/io'
import { start } from './start'

const READY_FILE = '/tmp/cargowall-ready'

/**
 * Model the state files cargowall writes. Absent paths make fs.access reject
 * and fs.readFile/fs.open/fs.stat throw, matching how the wait loop actually
 * probes them. fs.open returns a minimal FileHandle since the state-file
 * reader uses an O_NOFOLLOW open + bounded read rather than readFile. Present
 * files default to a future mtime (unambiguously fresher than the spawn
 * anchor); pass `mtimes` to model a leftover from a previous run (an old
 * epoch) or a write landing just inside the staleness slack. They are owned
 * by root, as cargowall writes them; pass `owners` to model a file another
 * user planted.
 */
function withFiles(
  files: Record<string, string>,
  mtimes: Record<string, number> = {},
  links: string[] = [],
  owners: Record<string, number> = {},
): void {
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
    const link = links.includes(String(p))
    if (!(String(p) in files) && !link) throw new Error(`ENOENT: ${String(p)}`)
    return { isFile: () => !link, isSymbolicLink: () => link } as Awaited<ReturnType<typeof fsp.lstat>>
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
      stat: async () => ({ isFile: () => true, uid: owners[String(p)] ?? 0 }),
      read: async (buf: Buffer, offset: number, length: number) => {
        const src = Buffer.from(content, 'utf8')
        const bytesRead = src.copy(buf, offset, 0, Math.min(src.length, length))
        return { bytesRead, buffer: buf }
      },
      close: async () => undefined,
    } as unknown as Awaited<ReturnType<typeof fsp.open>>
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

/** The whole argv handed to sudo, and the env the spawn was given. */
async function sudoArgs(): Promise<string[]> {
  await start()
  const call = vi.mocked(spawn).mock.calls.at(-1)
  if (!call) throw new Error('cargowall was never spawned')
  return call[1] as string[]
}

describe('start() and the environment it hands cargowall', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(core.getMultilineInput).mockImplementation(
      (name: string) => HOST_LIST_DEFAULTS[name] ?? []
    )
    vi.mocked(core.getIDToken).mockResolvedValue('oidc-token')
    vi.mocked(core.getInput).mockReturnValue('')
    vi.mocked(exec.exec).mockImplementation(async () => 0)
    withFiles({ [READY_FILE]: '' })
  })

  it("names only the allowlist in --preserve-env, whatever the job's environment carries", async () => {
      const inherited = process.env
      process.env = {
        PATH: '/usr/bin',
        HOME: '/home/runner',
        HTTPS_PROXY: 'http://proxy:3128',
        no_proxy: 'localhost',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example:4318',
        ACTIONS_RUNTIME_URL: 'https://pipelines.actions.githubusercontent.com/x/',
        CARGOWALL_AUDIT_MODE: 'true',
        CARGOWALL_TLS_SNI: 'off',
        CARGOWALL_SUDO_LOCKDOWN: 'true',
        CARGOWALL_API_URL: 'https://attacker.example',
        CODECARGO_AUTH_TOKEN: 'secret-token-value',
        SSL_CERT_FILE: '/tmp/evil-ca.pem',
        GITHUB_TOKEN: 'ghs_secret',
      }
      try {
        withInputs({ mode: 'enforce', offline: 'true' })
        const argv = await sudoArgs()
        const env = vi.mocked(spawn).mock.calls.at(-1)?.[2]?.env as NodeJS.ProcessEnv
        const preserve = argv[0]
        expect(preserve.startsWith('--preserve-env=')).toBe(true)
        expect(preserve.slice('--preserve-env='.length).split(',').sort()).toEqual([
          'ACTIONS_RUNTIME_URL',
          'CARGOWALL_AZURE_INFRA_HOSTS',
          'CARGOWALL_DEFAULT_ACTION',
          'CARGOWALL_GITHUB_SERVICE_HOSTS',
          'HTTPS_PROXY',
          'OTEL_EXPORTER_OTLP_ENDPOINT',
          'PATH',
          'no_proxy',
        ])
        // HOME is in the spawn env, for the sudo process, but not preserved.
        expect(Object.keys(env).sort()).toEqual([...preserve.slice('--preserve-env='.length).split(','), 'HOME'].sort())

        const warnings = vi.mocked(core.warning).mock.calls.map(c => String(c[0])).filter(w => w.includes('ignores'))
        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toContain('CARGOWALL_AUDIT_MODE, CARGOWALL_SUDO_LOCKDOWN, CARGOWALL_TLS_SNI')
        expect(warnings[0]).toContain('CODECARGO_AUTH_TOKEN')
        expect(warnings[0]).not.toContain('secret-token-value')
        expect(warnings[0]).not.toContain('attacker.example')
      } finally {
        process.env = inherited
      }
    })

  // sudo is found on the job's PATH, as every other sudo the action runs is
  // (io.which), since the spawn's environment carries cargowall's fixed one,
  // and before DNS is repointed, so a host without it fails with nothing
  // touched.
  it("spawns the sudo io.which finds, and fails before touching DNS without one", async () => {
    withInputs({ offline: 'true' })
    vi.mocked(io.which).mockResolvedValueOnce('/opt/tools/bin/sudo')
    await start()
    expect(io.which).toHaveBeenCalledWith('sudo', true)
    expect(vi.mocked(spawn).mock.calls.at(-1)?.[0]).toBe('/opt/tools/bin/sudo')

    vi.clearAllMocks()
    vi.mocked(exec.exec).mockImplementation(async () => 0)
    vi.mocked(io.which).mockRejectedValueOnce(new Error('Unable to locate executable file: sudo'))
    await expect(start()).rejects.toThrow('Unable to locate executable file: sudo')
    expect(spawn).not.toHaveBeenCalled()
    expect(exec.exec).not.toHaveBeenCalledWith('sudo', expect.arrayContaining(['tee']), expect.anything())
  })
})
