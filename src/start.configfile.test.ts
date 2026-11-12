import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * What start() hands cargowall for `config-file`. cargowall reads its local
 * configuration only when no CodeCargo policy loads, from the environment
 * when any configuration variable is set and from --config otherwise. So with
 * a config file, every run passes --config and no configuration variable,
 * while the API flags stay exactly as they are: a policy that loads still
 * replaces the file. Lives in its own file because it needs start()'s whole
 * module graph mocked, as start.spawn.test.ts does.
 */

vi.mock('@actions/core', () => ({
  getInput: vi.fn(() => ''),
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
    readFile: vi.fn(),
    writeFile: vi.fn(async () => undefined),
    open: vi.fn(),
    stat: vi.fn(),
    lstat: vi.fn(),
  },
}))

import * as core from '@actions/core'
import * as exec from '@actions/exec'
import { promises as fsp } from 'fs'
import { spawn } from 'child_process'
import * as path from 'path'
import { ENV_CONFIG_VARS } from './configfile'
import { start } from './start'

const READY_FILE = '/tmp/cargowall-ready'
const CONFIG = '/work/.github/cargowall.json'
const CONFIG_BODY = JSON.stringify({
  rules: [{ type: 'hostname', value: 'example.com', action: 'allow' }],
  steps: [{ id: 'build', rules: [{ type: 'hostname', value: 'registry.npmjs.org' }] }],
})
const API = 'https://app.codecargo.com'

/**
 * A root-owned ready sentinel, there from the first look, and the files
 * readFile serves: the config file among them.
 */
function withFiles(files: Record<string, string>): void {
  vi.mocked(fsp.readFile).mockImplementation(async (p: unknown) => {
    const body = files[String(p)]
    if (body === undefined) throw new Error(`ENOENT: ${String(p)}`)
    return body
  })
  vi.mocked(fsp.stat).mockImplementation(async (p: unknown) => {
    if (String(p) !== READY_FILE) throw new Error(`ENOENT: ${String(p)}`)
    return { mtimeMs: Date.now() + 5000, size: 1 } as Awaited<ReturnType<typeof fsp.stat>>
  })
  vi.mocked(fsp.lstat).mockImplementation(async (p: unknown) => {
    if (String(p) !== READY_FILE) throw new Error(`ENOENT: ${String(p)}`)
    return { isFile: () => true, isSymbolicLink: () => false } as Awaited<ReturnType<typeof fsp.lstat>>
  })
  vi.mocked(fsp.open).mockImplementation(async (p: unknown) => {
    if (String(p) !== READY_FILE) throw new Error(`ENOENT: ${String(p)}`)
    return {
      stat: async () => ({ isFile: () => true, uid: 0 }),
      read: async (buf: Buffer) => ({ bytesRead: 0, buffer: buf }),
      close: async () => undefined,
    } as unknown as Awaited<ReturnType<typeof fsp.open>>
  })
}

function withInputs(inputs: Record<string, string>, lists: Record<string, string[]> = {}): void {
  vi.mocked(core.getInput).mockImplementation((name: string) => inputs[name] ?? '')
  vi.mocked(core.getMultilineInput).mockImplementation((name: string) =>
    lists[name] ?? (name === 'github-service-hosts' ? ['github.com'] : name === 'azure-infra-hosts' ? ['trafficmanager.net'] : [])
  )
}

/** The cargowall argv and environment start() spawned. */
function spawned(): { args: string[]; env: NodeJS.ProcessEnv } {
  const call = vi.mocked(spawn).mock.calls.at(-1)
  if (!call) throw new Error('cargowall was never spawned')
  const argv = call[1] as string[]
  return { args: argv.slice(argv.indexOf('cargowall') + 1), env: call[2]?.env as NodeJS.ProcessEnv }
}

const flag = (args: string[], name: string) => args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1)

/** No variable that would make cargowall read the environment instead of the file. */
function expectNoEnvConfig(env: NodeJS.ProcessEnv): void {
  for (const name of ENV_CONFIG_VARS) expect(env[name], name).toBeUndefined()
}

/** start() refused before touching the runner: no resolv.conf write, no spawn. */
function expectNothingChanged(): void {
  expect(spawn).not.toHaveBeenCalled()
  expect(exec.exec).not.toHaveBeenCalledWith('sudo', expect.arrayContaining(['/etc/resolv.conf']), expect.anything())
  expect(exec.exec).not.toHaveBeenCalledWith('sudo', expect.arrayContaining(['tee']), expect.anything())
}

describe('start() and config-file', () => {
  const inherited = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(exec.exec).mockImplementation(async () => 0)
    vi.mocked(core.getIDToken).mockResolvedValue('oidc-token')
    withFiles({ [CONFIG]: CONFIG_BODY })
    // The job's own environment may carry a configuration variable too.
    process.env.CARGOWALL_BLOCKED_HOSTS = 'from-the-job.example'
  })

  afterEach(() => {
    process.env = { ...inherited }
  })

  it.each([
    ['offline', { offline: 'true', 'api-url': API }],
    ['skip-policy-fetch', { 'skip-policy-fetch': 'true', 'api-url': API }],
    ['no api-url', { 'api-url': '' }],
  ])('passes the file, and no environment configuration, when %s', async (_, inputs) => {
    withInputs({ ...inputs, 'config-file': CONFIG })
    await start()
    const { args, env } = spawned()

    expect(flag(args, '--config')).toBe(CONFIG)
    expect(flag(args, '--api-url')).toBeUndefined()
    expectNoEnvConfig(env)
  })

  it('passes the file, and no API flags, when the OIDC token is unavailable', async () => {
    withInputs({ 'api-url': API, 'config-file': CONFIG })
    vi.mocked(core.getIDToken).mockRejectedValue(new Error('no id-token permission'))
    await start()
    const { args, env } = spawned()

    expect(flag(args, '--config')).toBe(CONFIG)
    expect(flag(args, '--api-url')).toBeUndefined()
    expectNoEnvConfig(env)
  })

  it.each([
    ['audit', 'audit'],
    ['enforce', 'local'],
    ['fail', 'fail'],
  ])('keeps the policy fetch, and its %s failure posture, alongside the file', async (input, posture) => {
    // cargowall reads --config only when no policy loads, so the API flags
    // reaching it unchanged is what keeps a CodeCargo policy authoritative.
    withInputs({ 'api-url': API, 'api-failure-mode': input, 'config-file': CONFIG })
    await start()
    const { args, env } = spawned()

    expect(flag(args, '--api-url')).toBe(API)
    expect(flag(args, '--api-failure-mode')).toBe(posture)
    expect(flag(args, '--config')).toBe(CONFIG)
    expectNoEnvConfig(env)
  })

  it('resolves a relative path against the working directory cargowall shares', async () => {
    const resolved = path.resolve('.github/cargowall.json')
    withFiles({ [resolved]: CONFIG_BODY })
    withInputs({ offline: 'true', 'config-file': '.github/cargowall.json' })
    await start()
    expect(flag(spawned().args, '--config')).toBe(resolved)
  })

  it('without a file, sets the environment configuration from the inputs, as before', async () => {
    withInputs({ offline: 'true' }, { 'allowed-hosts': ['github.com'] })
    await start()
    const { args, env } = spawned()

    expect(flag(args, '--config')).toBeUndefined()
    expect(env.CARGOWALL_DEFAULT_ACTION).toBe('deny')
    expect(env.CARGOWALL_ALLOWED_HOSTS).toBe('github.com')
    expect(env.CARGOWALL_BLOCKED_HOSTS).toBe('from-the-job.example')
  })

  it.each(['allowed-hosts', 'allowed-cidrs', 'search-domains'])(
    'refuses %s alongside the file, before touching the runner',
    async input => {
      withInputs({ offline: 'true', 'config-file': CONFIG }, { [input]: ['x.example'] })
      await expect(start()).rejects.toThrow(`config-file can't be combined with ${input}`)
      expectNothingChanged()
    }
  )

  it('refuses a file that is missing, before touching the runner', async () => {
    withInputs({ offline: 'true', 'config-file': '/work/missing.json' })
    await expect(start()).rejects.toThrow("config-file /work/missing.json can't be read")
    expectNothingChanged()
  })

  it("refuses a file that isn't JSON, before touching the runner", async () => {
    withFiles({ [CONFIG]: 'rules:\n  - type: hostname\n' })
    withInputs({ offline: 'true', 'config-file': CONFIG })
    await expect(start()).rejects.toThrow(`config-file ${CONFIG} isn't JSON`)
    expectNothingChanged()
  })
})
