import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The pidfile cargowall writes names the process the action signals as root,
 * for liveness (`sudo kill -0`) and to stop it (`sudo kill`). It is trusted
 * only when root-owned, like the other state files. Lives in its own file
 * because it needs start()'s whole module graph mocked, as
 * start.spawn.test.ts does, with a ready sentinel that arrives late so the
 * wait loop reads the pidfile at all.
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
    access: vi.fn(),
    readFile: vi.fn(async () => { throw new Error('ENOENT') }),
    writeFile: vi.fn(async () => undefined),
    open: vi.fn(),
    stat: vi.fn(),
    lstat: vi.fn(),
  },
}))

import * as core from '@actions/core'
import * as exec from '@actions/exec'
import { promises as fsp } from 'fs'
import { start } from './start'

const READY_FILE = '/tmp/cargowall-ready'
const PID_FILE = '/tmp/cargowall.pid'
const LAUNCHER_PID = 4242

/**
 * State files cargowall wrote, fresh, owned by `owner`. The ready sentinel
 * shows up on the wait loop's second look, so its first pass reads the
 * pidfile and checks liveness.
 */
function withPidfile(content: string, owner: number): void {
  const files: Record<string, string> = { [READY_FILE]: '', [PID_FILE]: content }
  let readyLooks = 0
  vi.mocked(fsp.access).mockImplementation(async (p: unknown) => {
    if (!String(p).startsWith('/tmp/cargowall') || String(p) in files) return undefined
    throw new Error(`ENOENT: ${String(p)}`)
  })
  vi.mocked(fsp.stat).mockImplementation(async (p: unknown) => {
    if (String(p) === READY_FILE && readyLooks++ === 0) throw new Error('not yet')
    if (!(String(p) in files)) throw new Error(`ENOENT: ${String(p)}`)
    return { mtimeMs: Date.now() + 5000, size: 1 } as Awaited<ReturnType<typeof fsp.stat>>
  })
  vi.mocked(fsp.lstat).mockImplementation(async (p: unknown) => {
    if (!(String(p) in files)) throw new Error(`ENOENT: ${String(p)}`)
    return { isFile: () => true, isSymbolicLink: () => false } as Awaited<ReturnType<typeof fsp.lstat>>
  })
  vi.mocked(fsp.open).mockImplementation(async (p: unknown) => {
    const body = files[String(p)]
    if (body === undefined) throw new Error(`ENOENT: ${String(p)}`)
    return {
      stat: async () => ({ isFile: () => true, uid: owner }),
      read: async (buf: Buffer, offset: number, length: number) => {
        const src = Buffer.from(body, 'utf8')
        return { bytesRead: src.copy(buf, offset, 0, Math.min(src.length, length)), buffer: buf }
      },
      close: async () => undefined,
    } as unknown as Awaited<ReturnType<typeof fsp.open>>
  })
}

/** Every PID the action signalled through sudo. */
function signalledPids(): string[] {
  return vi.mocked(exec.exec).mock.calls
    .filter(([cmd, args]) => cmd === 'sudo' && args?.includes('kill'))
    .map(([, args]) => String(args?.at(-1)))
}

describe('start() and the cargowall pidfile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(core.getMultilineInput).mockImplementation((name: string) =>
      name === 'github-service-hosts' ? ['github.com'] : name === 'azure-infra-hosts' ? ['trafficmanager.net'] : []
    )
    vi.mocked(core.getInput).mockReturnValue('')
    vi.mocked(exec.exec).mockImplementation(async () => 0)
  })

  it('uses the PID in a root-owned pidfile', async () => {
    withPidfile('4243\n', 0)

    expect(await start()).toEqual({ supported: true, pid: 4243 })
    expect(signalledPids()).toEqual(['4243'])
  })

  it('ignores a pidfile another user owns, and signals nothing it names', async () => {
    withPidfile('31337\n', 1001)

    expect(await start()).toEqual({ supported: true, pid: LAUNCHER_PID })
    expect(signalledPids()).toEqual([])
    expect(core.saveState).toHaveBeenCalledWith('cargowall-pid', String(LAUNCHER_PID))
  })
})
