import { describe, it, expect, vi, beforeEach } from 'vitest'
import { promises as fs } from 'fs'

/**
 * Covers the `source-ref` path: a build-from-source install has no checksum
 * and no attestation to fall back on, so the only guarantees left are the ones
 * these tests pin — that the clone is the ref that was asked for, that the
 * version stamp cannot spill into the linker's flag list, and that a failed
 * build leaves no checkout behind.
 *
 * The filesystem is real (the temp checkout is created and removed for real,
 * which is what the cleanup test asserts); only the commands are mocked, so
 * nothing is cloned or compiled.
 */

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
  getInput: vi.fn(() => ''),
  startGroup: vi.fn(),
  endGroup: vi.fn()
}))
vi.mock('@actions/exec', () => ({ exec: vi.fn() }))
vi.mock('@actions/io', () => ({ which: vi.fn(async () => '/usr/local/bin/cargowall') }))
// setup.ts builds an HttpClient at module scope; this path never uses it.
vi.mock('@actions/http-client', () => ({ HttpClient: class { get = vi.fn() } }))

import * as exec from '@actions/exec'
import * as io from '@actions/io'
import { buildFromSource } from './setup'

const SHA = 'abc1234'

type Call = { cmd: string; args: string[]; opts?: exec.ExecOptions }
let calls: Call[]

/** The command whose args contain `marker`, or undefined. */
const callWith = (cmd: string, marker: string): Call | undefined =>
  calls.find(c => c.cmd === cmd && c.args.includes(marker))

/** Everything after `-ldflags` in the go build invocation. */
function ldflags(): string {
  const build = callWith('go', 'build')
  expect(build).toBeDefined()
  const i = build!.args.indexOf('-ldflags')
  expect(i).toBeGreaterThanOrEqual(0)
  return build!.args[i + 1]
}

/** The temp checkout, read back off the clone's destination argument. */
function srcDir(): string {
  const clone = callWith('git', 'clone')
  expect(clone).toBeDefined()
  return clone!.args[clone!.args.length - 1]
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(io.which).mockResolvedValue('/usr/local/bin/cargowall')
  calls = []
  vi.mocked(exec.exec).mockImplementation(async (cmd, args = [], opts) => {
    calls.push({ cmd, args, opts })
    if (cmd === 'git' && args.includes('rev-parse')) {
      opts?.listeners?.stdout?.(Buffer.from(`${SHA}\n`))
    }
    return 0
  })
})

describe('buildFromSource', () => {
  it('shallow-clones the requested ref from the public repo', async () => {
    await buildFromSource('my-branch')

    const clone = callWith('git', 'clone')!
    expect(clone.args.slice(0, 5)).toEqual(['clone', '--depth', '1', '--branch', 'my-branch'])
    expect(clone.args[5]).toBe('https://github.com/code-cargo/cargowall.git')
  })

  it('stamps the binary with the ref and the resolved short sha', async () => {
    await buildFromSource('my-branch')

    expect(ldflags()).toBe(`-w -s -X main.version=my-branch-${SHA}`)
  })

  it('builds a static linux binary from the checkout, as the Makefile does', async () => {
    await buildFromSource('my-branch')

    const build = callWith('go', 'build')!
    expect(build.opts?.cwd).toBe(srcDir())
    expect(build.opts?.env?.GOOS).toBe('linux')
    expect(build.opts?.env?.CGO_ENABLED).toBe('0')
    expect(build.args[build.args.indexOf('-o') + 1]).toBe(`${srcDir()}/cargowall`)
  })

  it('scrubs a stamp that would otherwise spill into the linker flag list', async () => {
    await buildFromSource('evil -X main.apiKey=leaked')

    const stamp = ldflags().replace('-w -s -X main.version=', '')
    expect(stamp).not.toMatch(/\s/)
    expect(ldflags().split(/\s+/)).toHaveLength(4)
  })

  it('installs the built binary and confirms it resolves in PATH', async () => {
    await buildFromSource('my-branch')

    expect(callWith('sudo', 'mv')!.args).toEqual(['mv', `${srcDir()}/cargowall`, '/usr/local/bin/cargowall'])
    expect(io.which).toHaveBeenCalledWith('cargowall', true)
  })

  it('fails when the built binary is not on PATH afterwards', async () => {
    vi.mocked(io.which).mockRejectedValue(new Error('not found'))

    await expect(buildFromSource('my-branch')).rejects.toThrow('not found in PATH')
  })

  it('removes the checkout when the build fails, and surfaces the failure', async () => {
    vi.mocked(exec.exec).mockImplementation(async (cmd, args = [], opts) => {
      calls.push({ cmd, args, opts })
      if (cmd === 'git' && args.includes('rev-parse')) {
        opts?.listeners?.stdout?.(Buffer.from(`${SHA}\n`))
      }
      if (cmd === 'go') throw new Error('go: build failed')
      return 0
    })

    await expect(buildFromSource('my-branch')).rejects.toThrow('go: build failed')
    await expect(fs.access(srcDir())).rejects.toThrow()
  })

  it('removes the checkout on the happy path too', async () => {
    await buildFromSource('my-branch')

    await expect(fs.access(srcDir())).rejects.toThrow()
  })
})
