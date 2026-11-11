import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The pidfile and the ready sentinel are trusted only when root-owned, like
 * the other state files: the pidfile names the process the action signals as
 * root, for liveness (`sudo kill -0`) and to stop it (`sudo kill`), and the
 * ready sentinel ends the startup wait. Lives in its own file because it
 * needs start()'s whole module graph mocked, as start.spawn.test.ts does.
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

interface StateFile {
  body: string
  owner: number
  /** Written before this run's spawn: a leftover from a previous job. */
  stale?: boolean
}

/**
 * State files cargowall wrote, fresh. The ready sentinel shows up on the wait
 * loop's look `readyLook` (from 0), so by default its first pass reads the
 * pidfile and checks liveness.
 */
function withStateFiles(files: Record<string, StateFile>, readyLook = 1): void {
  let readyLooks = 0
  vi.mocked(fsp.access).mockImplementation(async (p: unknown) => {
    if (!String(p).startsWith('/tmp/cargowall') || String(p) in files) return undefined
    throw new Error(`ENOENT: ${String(p)}`)
  })
  vi.mocked(fsp.stat).mockImplementation(async (p: unknown) => {
    if (String(p) === READY_FILE && readyLooks++ < readyLook) throw new Error('not yet')
    if (!(String(p) in files)) throw new Error(`ENOENT: ${String(p)}`)
    return { mtimeMs: files[String(p)].stale ? 0 : Date.now() + 5000, size: 1 } as Awaited<ReturnType<typeof fsp.stat>>
  })
  vi.mocked(fsp.lstat).mockImplementation(async (p: unknown) => {
    if (!(String(p) in files)) throw new Error(`ENOENT: ${String(p)}`)
    return { isFile: () => true, isSymbolicLink: () => false } as Awaited<ReturnType<typeof fsp.lstat>>
  })
  vi.mocked(fsp.open).mockImplementation(async (p: unknown) => {
    const file = files[String(p)]
    if (file === undefined) throw new Error(`ENOENT: ${String(p)}`)
    return {
      stat: async () => ({ isFile: () => true, uid: file.owner }),
      read: async (buf: Buffer, offset: number, length: number) => {
        const src = Buffer.from(file.body, 'utf8')
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

/**
 * start(), run to the end of its readiness wait however many one-second
 * sleeps that takes.
 */
async function startToTheEnd(): ReturnType<typeof start> {
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  try {
    let settled = false
    const run = start().finally(() => { settled = true })
    for (let i = 0; !settled && i < 1000; i++) await vi.advanceTimersByTimeAsync(1000)
    return await run
  } finally {
    vi.useRealTimers()
  }
}

/** A ready sentinel, owned by `owner`. */
const ready = (owner: number): StateFile => ({ body: '', owner })

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
    withStateFiles({ [READY_FILE]: ready(0), [PID_FILE]: { body: '4243\n', owner: 0 } })

    expect(await start()).toEqual({ supported: true, pid: 4243 })
    expect(signalledPids()).toEqual(['4243'])
  })

  it("ignores a previous run's root-owned pidfile, and signals nothing it names", async () => {
    withStateFiles({ [READY_FILE]: ready(0), [PID_FILE]: { body: '31337\n', owner: 0, stale: true } })

    expect(await start()).toEqual({ supported: true, pid: LAUNCHER_PID })
    expect(signalledPids()).toEqual([])
  })

  it('stops cargowall through its launcher on a timeout with no trusted pidfile', async () => {
    withStateFiles({ [PID_FILE]: { body: '31337\n', owner: 0, stale: true } })

    expect(await startToTheEnd()).toEqual({ supported: false, pid: null })
    expect(core.error).toHaveBeenCalledWith('Timeout waiting for cargowall to be ready')
    expect(signalledPids()).toEqual([String(LAUNCHER_PID)])
    expect(exec.exec).toHaveBeenCalledWith('sudo', ['kill', String(LAUNCHER_PID)], expect.anything())
  })

  it('ignores a pidfile another user owns, and signals nothing it names', async () => {
    withStateFiles({ [READY_FILE]: ready(0), [PID_FILE]: { body: '31337\n', owner: 1001 } })

    expect(await start()).toEqual({ supported: true, pid: LAUNCHER_PID })
    expect(signalledPids()).toEqual([])
    expect(core.saveState).toHaveBeenCalledWith('cargowall-pid', String(LAUNCHER_PID))
  })
})

describe('start() and the ready sentinel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(core.getMultilineInput).mockImplementation((name: string) =>
      name === 'github-service-hosts' ? ['github.com'] : name === 'azure-infra-hosts' ? ['trafficmanager.net'] : []
    )
    vi.mocked(core.getInput).mockReturnValue('')
    // cargowall (4243) has exited; sudo itself works.
    vi.mocked(exec.exec).mockImplementation(async (cmd: string, args?: string[]) =>
      cmd === 'sudo' && args?.join(' ') === '-n kill -0 4243' ? 1 : 0
    )
  })

  it('does not end the wait on a ready sentinel another user owns', async () => {
    withStateFiles({ [READY_FILE]: ready(1001), [PID_FILE]: { body: '4243\n', owner: 0 } }, 0)

    expect(await start()).toEqual({ supported: false, pid: null })
    expect(core.error).toHaveBeenCalledWith('CargoWall process exited unexpectedly')
    expect(core.info).not.toHaveBeenCalledWith('CargoWall is ready')
  })
})
