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
  getState: vi.fn(() => ''),
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
// For the post step, which the FIX-A case runs after start().
vi.mock('./summary', () => ({ generateSummary: vi.fn(async () => undefined) }))
vi.mock('./cleanup', () => ({ cleanup: vi.fn(async () => undefined) }))
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
import { generateSummary } from './summary'
import { start } from './start'

const READY_FILE = '/tmp/cargowall-ready'
const POSTURES_FILE = '/tmp/cargowall-postures'
const CARGOWALL_LOG = '/tmp/cargowall.log'
const LOADED = '2026-11-12 00:00:01.000 Config loaded successfully rules=1 defaultAction=deny searchDomains=0\n'
const CONFIG = '/work/.github/cargowall.json'
const CONFIG_BODY = JSON.stringify({
  rules: [{ type: 'hostname', value: 'example.com', action: 'allow' }],
  steps: [{ id: 'build', rules: [{ type: 'hostname', value: 'registry.npmjs.org' }] }],
})
const API = 'https://app.codecargo.com'

/** The example file the README gives under "With Config File". */
async function readmeExample(): Promise<string> {
  const { readFileSync } = await vi.importActual<typeof import('fs')>('fs')
  const readme = readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8')
  const example = readme.match(/\*\*`\.github\/cargowall\.json`\*\*:\n```json\n([\s\S]*?)\n```/)
  if (!example) throw new Error("README has no cargowall.json example")
  return example[1]
}

/**
 * The files readFile serves (the config file and cargowall's log among them,
 * the log saying the file loaded unless a test says otherwise), and the
 * root-owned, fresh state files cargowall writes: the ready sentinel, there
 * from the first look, and any others given.
 */
function withFiles(files: Record<string, string>, state: Record<string, string> = {}): void {
  const all: Record<string, string> = { [CARGOWALL_LOG]: LOADED, ...files }
  const states: Record<string, string> = { [READY_FILE]: '', ...state }
  vi.mocked(fsp.readFile).mockImplementation(async (p: unknown) => {
    const body = all[String(p)]
    if (body === undefined) throw new Error(`ENOENT: ${String(p)}`)
    return body
  })
  vi.mocked(fsp.stat).mockImplementation(async (p: unknown) => {
    if (!(String(p) in states)) throw new Error(`ENOENT: ${String(p)}`)
    return { mtimeMs: Date.now() + 5000, size: 1 } as Awaited<ReturnType<typeof fsp.stat>>
  })
  vi.mocked(fsp.lstat).mockImplementation(async (p: unknown) => {
    if (!(String(p) in states)) throw new Error(`ENOENT: ${String(p)}`)
    return { isFile: () => true, isSymbolicLink: () => false } as Awaited<ReturnType<typeof fsp.lstat>>
  })
  vi.mocked(fsp.open).mockImplementation(async (p: unknown) => {
    const body = states[String(p)]
    if (body === undefined) throw new Error(`ENOENT: ${String(p)}`)
    return {
      stat: async () => ({ isFile: () => true, uid: 0 }),
      read: async (buf: Buffer, offset: number, length: number) => {
        const src = Buffer.from(body, 'utf8')
        return { bytesRead: src.copy(buf, offset, 0, Math.min(src.length, length)), buffer: buf }
      },
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

  it.each([
    ['an array', '[]'],
    ['null', 'null'],
    ['a key cargowall does not read', '{"rule": [{"type": "hostname", "value": "example.com", "action": "allow"}]}'],
  ])('refuses %s, before touching the runner', async (_, body) => {
    withFiles({ [CONFIG]: body })
    withInputs({ offline: 'true', 'config-file': CONFIG })
    await expect(start()).rejects.toThrow(`config-file ${CONFIG}`)
    expectNothingChanged()
  })

  it("fails the step when cargowall's log shows the file didn't load", async () => {
    withFiles({
      [CONFIG]: CONFIG_BODY,
      [CARGOWALL_LOG]: '::warning::No config loaded — defaulting to deny-all. Infrastructure hosts will be auto-allowed. ' +
        'error="parse config: json: cannot unmarshal number into Go struct field Rule.rules.ports of type config.Port"\n',
    })
    withInputs({ offline: 'true', 'config-file': CONFIG })
    await expect(start()).rejects.toThrow(
      /did not load config-file .*running deny-all, with only CI infrastructure allowed \(in audit, every other connection is reported as would-deny\)\. .*cargowall said: No config loaded .*cannot unmarshal number/
    )
  })

  it('fails the step when the log shows no load at all', async () => {
    withFiles({ [CONFIG]: CONFIG_BODY, [CARGOWALL_LOG]: 'Starting\n' })
    withInputs({ offline: 'true', 'config-file': CONFIG })
    await expect(start()).rejects.toThrow(`did not load config-file ${CONFIG}`)
  })

  it('passes when a CodeCargo policy loaded instead of the file', async () => {
    withFiles({ [CONFIG]: CONFIG_BODY, [CARGOWALL_LOG]: '2026-11-12 00:00:01.000 Policy loaded from CodeCargo API mode=CARGO_WALL_MODE_ENFORCE\n' })
    withInputs({ 'api-url': API, 'config-file': CONFIG })
    await expect(start()).resolves.toMatchObject({ supported: true })
  })

  it("announces and reports the lockdown the file set, offline, over this step's input", async () => {
    // The file turned the lockdown off: cargowall's record has no line for it.
    withFiles({ [CONFIG]: '{"sudoLockdown":{"enabled":false}}' }, { [POSTURES_FILE]: '[]' })
    withInputs({ offline: 'true', 'sudo-lockdown': 'true', 'config-file': CONFIG })
    await start()

    const info = vi.mocked(core.info).mock.calls.map(([line]) => String(line))
    expect(info).toContain("  Sudo lockdown: false (set by the config file, which replaces this step's input: true)")
    expect(info).toContain("Sudo lockdown: off (set by the config file, which replaces this step's input: true)")
    expect(info.filter(line => /Sudo lockdown: (true|on)\b/.test(line))).toEqual([])
  })

  it("credits nothing to a file that doesn't set sudoLockdown", async () => {
    withFiles({ [CONFIG]: CONFIG_BODY }, { [POSTURES_FILE]: '[{"posture":"sudo-lockdown","requested":"true","applied":"true"}]' })
    withInputs({ offline: 'true', 'sudo-lockdown': 'true', 'config-file': CONFIG })
    await start()

    const info = vi.mocked(core.info).mock.calls.map(([line]) => String(line))
    expect(info).toContain('  Sudo lockdown: true')
    expect(info.filter(line => line.includes('config file'))).toEqual([])
  })

  it.each([
    ['a port with no protocol', '{"rules":[{"type":"hostname","value":"example.com","action":"allow","ports":[{"port":443}]}]}', 'rules[0].ports[0] needs a protocol'],
    ['an uppercase protocol', '{"rules":[{"type":"hostname","value":"example.com","action":"allow","ports":[{"port":443,"protocol":"TCP"}]}]}', 'rules[0].ports[0] needs a protocol'],
    ['an unknown protocol', '{"rules":[{"type":"hostname","value":"example.com","action":"allow","ports":[{"port":443,"protocol":"http"}]}]}', 'rules[0].ports[0] needs a protocol'],
    ['a port as a bare number', '{"rules":[{"type":"cidr","value":"10.0.0.0/8","action":"allow","ports":[443]}]}', 'rules[0].ports[0] needs a protocol'],
    ['a step port with no protocol', '{"steps":[{"id":"build","rules":[{"type":"hostname","value":"a.example","ports":[{"port":443}]}]}]}', 'steps[0].rules[0].ports[0] needs a protocol'],
    ['a misspelled rule key', '{"rules":[{"type":"hostname","value":"example.com","action":"allow","port":[{"port":443,"protocol":"tcp"}]}]}', "rules[0] has keys cargowall doesn't read: port"],
  ])('refuses %s, before touching the runner', async (_, body, message) => {
    withFiles({ [CONFIG]: body })
    withInputs({ offline: 'true', 'config-file': CONFIG })
    await expect(start()).rejects.toThrow(`config-file ${CONFIG}: ${message}`)
    expectNothingChanged()
  })

  it.each([
    ['a case variant beside a port key', '{"rules":[{"type":"hostname","value":"example.com","action":"allow","ports":[{"port":443,"protocol":"tcp","Protocol":"TCP"}]}]}', "rules[0].ports[0] has keys cargowall doesn't read: Protocol"],
    ['a misspelled sudoLockdown key', '{"sudoLockdown":{"enable":true}}', "sudoLockdown has keys cargowall doesn't read: enable"],
    ['a case variant of a step key', '{"steps":[{"id":"build","rules":[],"Rules":[]}]}', "steps[0] has keys cargowall doesn't read: Rules"],
    ['ports that are not a list', '{"rules":[{"type":"hostname","value":"example.com","action":"allow","ports":{"port":443,"protocol":"tcp"}}]}', "rules[0].ports isn't a list"],
    ['rules as null', '{"rules":null}', "rules isn't a list"],
    ['steps as null', '{"steps":null}', "steps isn't a list"],
    ['ports as null', '{"rules":[{"type":"hostname","value":"example.com","action":"allow","ports":null}]}', "rules[0].ports isn't a list"],
  ])('refuses %s, before touching the runner', async (_, body, message) => {
    withFiles({ [CONFIG]: body })
    withInputs({ offline: 'true', 'config-file': CONFIG })
    await expect(start()).rejects.toThrow(`config-file ${CONFIG}: ${message}`)
    expectNothingChanged()
  })

  it.each([
    ['an empty port list', '{"rules":[{"type":"cidr","value":"93.184.216.0/24","action":"allow","ports":[]}]}', 'rules[0].ports is empty, which cargowall reads as every port: leave ports out for every port'],
    ['an empty step port list', '{"steps":[{"id":"build","rules":[{"type":"hostname","value":"a.example","ports":[]}]}]}', 'steps[0].rules[0].ports is empty'],
    ['a capitalised type', '{"rules":[{"type":"Hostname","value":"example.com","action":"allow"}]}', 'rules[0].type must be "hostname" or "cidr", in lowercase'],
    ['an uppercase cidr type', '{"rules":[{"type":"CIDR","value":"10.0.0.0/8","action":"allow"}]}', 'rules[0].type must be "hostname" or "cidr"'],
    ['a rule with no type', '{"rules":[{"value":"example.com","action":"allow"}]}', 'rules[0].type must be "hostname" or "cidr"'],
    ['a step rule with no type', '{"steps":[{"id":"build","rules":[{"value":"a.example"}]}]}', 'steps[0].rules[0].type must be "hostname" or "cidr"'],
    ['an empty value', '{"rules":[{"type":"hostname","value":"","action":"allow"}]}', 'rules[0].value must be a non-empty string'],
    ['a rule with no value', '{"rules":[{"type":"cidr","action":"allow"}]}', 'rules[0].value must be a non-empty string'],
    ['a capitalised action', '{"rules":[{"type":"hostname","value":"example.com","action":"Allow"}]}', 'rules[0].action must be "allow" or "deny", in lowercase'],
    ["the README's step rule given as a job rule", '{"rules":[{"type":"hostname","value":"npm.pkg.github.com"}]}', 'rules[0].action must be "allow" or "deny"'],
    ['a step rule that denies', '{"steps":[{"id":"build","rules":[{"type":"hostname","value":"a.example","action":"deny"}]}]}', 'steps[0].rules[0].action must be "allow", in lowercase, or left out'],
    ['a capitalised step action', '{"steps":[{"id":"build","rules":[{"type":"hostname","value":"a.example","action":"Allow"}]}]}', 'steps[0].rules[0].action must be "allow"'],
    ['a capitalised defaultAction', '{"defaultAction":"Allow"}', 'defaultAction must be "allow" or "deny", in lowercase, or left out for deny'],
    ['a null defaultAction', '{"defaultAction":null}', 'defaultAction must be "allow" or "deny"'],
  ])('refuses %s, before touching the runner', async (_, body, message) => {
    withFiles({ [CONFIG]: body })
    withInputs({ offline: 'true', 'config-file': CONFIG })
    await expect(start()).rejects.toThrow(`config-file ${CONFIG}: ${message}`)
    expectNothingChanged()
  })

  it.each([
    ['a repeated protocol', '{"rules":[{"type":"hostname","value":"example.com","action":"allow","ports":[{"port":443,"protocol":"TCP","protocol":"tcp"}]}]}', 'rules[0].ports[0] repeats the key protocol'],
    ['a repeat spelled with an escape', '{"rules":[{"type":"hostname","value":"example.com","action":"allow","ports":[{"port":443,"protocol":"TCP","prot\\u006fcol":"tcp"}]}]}', 'rules[0].ports[0] repeats the key protocol'],
    ['a repeated sudoLockdown', '{"sudoLockdown":{"enabled":true},"sudoLockdown":{"allowCommands":["/usr/bin/true"]}}', 'the file repeats the key sudoLockdown'],
    ['a repeated rule list', '{"rules":[{"type":"cidr","value":"10.0.0.0/8","action":"allow"}],"rules":[{"type":"cidr","value":"10.0.0.0/8","action":"allow"}]}', 'the file repeats the key rules'],
    ['a repeated key in a later step', '{"steps":[{"id":"a","rules":[]},{"id":"b","id":"c","rules":[]}]}', 'steps[1] repeats the key id'],
  ])('refuses %s, before touching the runner', async (_, body, message) => {
    withFiles({ [CONFIG]: body })
    withInputs({ offline: 'true', 'config-file': CONFIG })
    await expect(start()).rejects.toThrow(`config-file ${CONFIG}: ${message}; give each key once`)
    expectNothingChanged()
  })

  it.each([
    ['a host with a port', 'example.com:443', 'has a port: give the host alone and its ports in ports'],
    ['a URL', 'https://example.com', 'is a URL or a path, not a hostname'],
    ['a path', 'example.com/path', 'is a URL or a path, not a hostname'],
    ['a leading space', ' example.com', 'has whitespace'],
    ['a space inside', 'exa mple.com', 'has whitespace'],
    ['a trailing dot', 'example.com.', 'ends with a dot'],
    ['an IPv4 address', '1.2.3.4', 'is an IP address: give it as type cidr'],
    ['an IPv6 address', '2001:db8::1', 'is an IP address: give it as type cidr'],
    ['a leading dot', '.example.com', 'starts with a dot: leave it out, since a name already covers its subdomains'],
    ['a comma-joined list', 'example.com,api.example.com', 'lists more than one host: give one host per rule'],
    ['an empty label', 'example..com', 'is not a hostname'],
    ['a non-punycode IDN', 'bücher.example.com', 'has a non-ASCII character: give the punycode (xn--) form'],
    ['a zero-width space', 'example.com\u200b', 'has a non-ASCII character'],
    ['trailing punctuation', 'example.com;', 'is not a hostname'],
    ['a leading hyphen', '-example.com', 'is not a hostname'],
    ['a label ending in a hyphen', 'example-.com', 'is not a hostname'],
    ['a partial pattern', 'api-*.example.com', 'is not a hostname'],
    ['a 64-character label', `${'a'.repeat(64)}.example.com`, 'has a label longer than 63 characters'],
    ['a 254-character name', `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`, 'is longer than 253 characters'],
  ])('refuses a hostname value that is %s, before touching the runner', async (_, value, message) => {
    for (const [body, where] of [
      [JSON.stringify({ rules: [{ type: 'hostname', value, action: 'allow' }] }), 'rules[0]'],
      [JSON.stringify({ steps: [{ id: 'build', rules: [{ type: 'hostname', value }] }] }), 'steps[0].rules[0]'],
    ]) {
      vi.clearAllMocks()
      withFiles({ [CONFIG]: body })
      withInputs({ offline: 'true', 'config-file': CONFIG })
      await expect(start()).rejects.toThrow(`config-file ${CONFIG}: ${where}.value ${JSON.stringify(value)} ${message}`)
      expectNothingChanged()
    }
  })

  it.each([
    ['with arguments', '"/usr/bin/apt-get install -y curl"'],
    ['a relative path', '"apt-get"'],
    ['not a string', '42'],
  ])('refuses a sudo allowlist entry %s, before touching the runner', async (_, entry) => {
    // After a good entry, so the index is checked too.
    withFiles({ [CONFIG]: `{"sudoLockdown":{"enabled":true,"allowCommands":["/usr/bin/true",${entry}]}}` })
    withInputs({ offline: 'true', 'config-file': CONFIG })
    await expect(start()).rejects.toThrow(`config-file ${CONFIG}: sudoLockdown.allowCommands[1] must be a bare absolute path`)
    expectNothingChanged()
  })

  it.each([
    ['a comma', '/usr/bin/true,/bin/bash'],
    ['a glob', '/usr/bin/*'],
    ['a semicolon', '/usr/bin/true;id'],
    ['a backslash', '/usr/bin/a\\b'],
  ])('refuses a sudo allowlist entry with %s, before touching the runner', async (_, entry) => {
    withFiles({ [CONFIG]: JSON.stringify({ sudoLockdown: { enabled: true, allowCommands: ['/usr/bin/true', entry] } }) })
    withInputs({ offline: 'true', 'config-file': CONFIG })
    await expect(start()).rejects.toThrow(
      `config-file ${CONFIG}: sudoLockdown.allowCommands[1] has a character a sudoers command path can't hold`
    )
    expectNothingChanged()
  })

  it('refuses a sudo allowlist that is not a list, before touching the runner', async () => {
    withFiles({ [CONFIG]: '{"sudoLockdown":{"enabled":true,"allowCommands":"/usr/bin/true"}}' })
    withInputs({ offline: 'true', 'config-file': CONFIG })
    await expect(start()).rejects.toThrow(`config-file ${CONFIG}: sudoLockdown.allowCommands isn't a list`)
    expectNothingChanged()
  })

  it.each([
    ['a step rule that says allow', '{"steps":[{"id":"build","rules":[{"type":"hostname","value":"a.example","action":"allow"}]}]}'],
    ['a default allow', '{"defaultAction":"allow","rules":[{"type":"cidr","value":"10.0.0.0/8","action":"deny"}]}'],
    [
      'the same keys in different objects, and strings that look like JSON',
      '{"rules":[{"type":"hostname","value":"example.com","action":"allow"},{"type":"cidr","value":"10.0.0.0/8","action":"deny"}],' +
        '"searchDomains":["a\\"b,{\\"rules\\":[]}\\\\"],"steps":[{"id":"a","rules":[]},{"id":"b","rules":[]}]}',
    ],
    ['a value spelled like a key beside it', '{"rules":[{"type":"hostname","value":"type","action":"allow"}]}'],
    [
      'hostname patterns and underscores',
      '{"rules":[{"type":"hostname","value":"*.example.com","action":"allow"},{"type":"hostname","value":"**.example.com","action":"allow"},' +
        '{"type":"hostname","value":"_gateway","action":"allow"},{"type":"hostname","value":"_dmarc.example.com","action":"deny"}],' +
        '"steps":[{"id":"build","rules":[{"type":"hostname","value":"*.npmjs.org"}]}]}',
    ],
    [
      'hostnames of every admitted shape',
      JSON.stringify({
        rules: ['_gateway', '*.npmjs.org', '**.example.com', 'xn--bcher-kva.example', `${'a'.repeat(63)}.example.com`,
          `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`, 'a.b-c.d_e.example', 'localhost']
          .map(value => ({ type: 'hostname', value, action: 'allow' })),
      }),
    ],
    ['a CIDR given as an address', '{"rules":[{"type":"cidr","value":"1.2.3.4","action":"allow"},{"type":"cidr","value":"2001:db8::1","action":"allow"}]}'],
    ['a sudo allowlist of bare absolute paths', '{"sudoLockdown":{"enabled":true,"allowCommands":["/usr/bin/apt-get","/usr/bin/true"]}}'],
    ["the README's example", ''],
  ])('accepts %s', async (_, body) => {
    withFiles({ [CONFIG]: body || await readmeExample() })
    withInputs({ offline: 'true', 'config-file': CONFIG })
    await expect(start()).resolves.toMatchObject({ supported: true })
  })

  it.each([
    ['an invalid CIDR', '::error::Invalid CIDR/IP value=10.0.0.0/33 error=invalid CIDR address: 10.0.0.0/33'],
    ['an invalid pattern', '::error::Invalid hostname pattern value=api-*.example.com error=partial wildcard'],
    ['an unknown type', '::error::Unknown Rule type type=Hostname'],
  ])('fails the step when cargowall loaded the file without a rule, over %s', async (_, line) => {
    // Every resolve logs it again: the step quotes it once.
    withFiles({ [CONFIG]: CONFIG_BODY, [CARGOWALL_LOG]: `${LOADED}${line}\n${line}\n` })
    withInputs({ offline: 'true', 'config-file': CONFIG })
    const said = line.slice('::error::'.length)
    const error = String(await start().catch((e: unknown) => e))
    expect(error).toContain(
      `CargoWall loaded config-file ${CONFIG} but dropped rules from it, so they don't apply. Fix the file; cargowall said: ${said}`
    )
    expect(error).not.toContain(`${said}; ${said}`)
  })

  it("passes over a policy's own dropped rule, and over the error quoted in another line", async () => {
    withFiles({
      [CONFIG]: CONFIG_BODY,
      [CARGOWALL_LOG]: '2026-11-12 00:00:01.000 Policy loaded from CodeCargo API mode=CARGO_WALL_MODE_ENFORCE\n' +
        '::error::Invalid CIDR/IP value=10.0.0.0/33 error=invalid CIDR address: 10.0.0.0/33\n',
    })
    withInputs({ 'api-url': API, 'config-file': CONFIG })
    await expect(start()).resolves.toMatchObject({ supported: true })

    withFiles({ [CONFIG]: CONFIG_BODY, [CARGOWALL_LOG]: `${LOADED}::warning::quoted ::error::Invalid CIDR/IP value=10.0.0.0/33\n` })
    withInputs({ offline: 'true', 'config-file': CONFIG })
    await expect(start()).resolves.toMatchObject({ supported: true })
  })

  it.each([
    ['the file', LOADED],
    ['a policy', '2026-11-12 00:00:01.000 Policy loaded from CodeCargo API mode=CARGO_WALL_MODE_ENFORCE\n'],
  ])('fails the step when the success line for %s is only quoted, with no warning either', async (_, line) => {
    withFiles({ [CONFIG]: CONFIG_BODY, [CARGOWALL_LOG]: `::debug::quoted ${line}` })
    withInputs({ offline: 'true', 'config-file': CONFIG })
    await expect(start()).rejects.toThrow(`did not load config-file ${CONFIG}`)
  })

  it('fails the step on a failed load whose error quotes the success line', async () => {
    withFiles({
      [CONFIG]: CONFIG_BODY,
      [CARGOWALL_LOG]: '::warning::No config loaded — defaulting to deny-all. ' +
        'error=steps[0]: step id "Config loaded successfully": must start with a letter or _\n',
    })
    withInputs({ offline: 'true', 'config-file': CONFIG })
    await expect(start()).rejects.toThrow(`did not load config-file ${CONFIG}`)
  })

  it('fails the step on a "No config loaded" warning, whatever else the log holds', async () => {
    withFiles({ [CONFIG]: CONFIG_BODY, [CARGOWALL_LOG]: LOADED + '::warning::No config loaded — defaulting to deny-all.\n' })
    withInputs({ offline: 'true', 'config-file': CONFIG })
    await expect(start()).rejects.toThrow(`did not load config-file ${CONFIG}`)
  })

  it('credits the file after a 404, with the API in play, when it sets sudoLockdown', async () => {
    // No mode file and no downgrade: the API answered with no policy.
    withFiles({ [CONFIG]: '{"sudoLockdown":{"enabled":false}}' }, { [POSTURES_FILE]: '[]' })
    withInputs({ 'api-url': API, 'sudo-lockdown': 'true', 'config-file': CONFIG })
    await start()

    const info = vi.mocked(core.info).mock.calls.map(([line]) => String(line))
    expect(info).toContain(
      "  Sudo lockdown: true (this step's input; a CodeCargo policy that sets sudo lockdown replaces it, and the config file's false does when no policy loads)"
    )
    expect(info).toContain("Sudo lockdown: off (set by the config file, which replaces this step's input: true)")
  })

  it('leaves the post step to summarise a run whose file cargowall did not load', async () => {
    withFiles({ [CONFIG]: CONFIG_BODY, [CARGOWALL_LOG]: '::warning::No config loaded — defaulting to deny-all.\n' })
    withInputs({ offline: 'true', 'config-file': CONFIG })
    await expect(start()).rejects.toThrow('did not load config-file')

    // What start() saved is what the post step reads.
    const state = Object.fromEntries(vi.mocked(core.saveState).mock.calls.map(([k, v]) => [k, String(v)]))
    expect(state['cargowall-pid']).toBeTruthy()
    vi.mocked(core.getState).mockImplementation((name: string) => state[name] ?? '')
    vi.resetModules()
    await import('./post')
    await vi.waitFor(() => expect(generateSummary).toHaveBeenCalledWith({ render: true }))
    expect(core.info).not.toHaveBeenCalledWith('CargoWall never ran in this job, skipping summary')
  })
})
