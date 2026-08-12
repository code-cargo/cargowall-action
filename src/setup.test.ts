import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import { Readable } from 'stream'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * #79: setup ran before the firewall is up, so a single ECONNRESET from the
 * release CDN failed the whole job — the old one-shot retry gave the CDN
 * ~650 ms to recover. These tests pin the backoff loop's shape: what gets
 * retried, what doesn't, and that nothing partial survives a failed attempt.
 *
 * Real filesystem, mocked socket: the truncation cases are exactly the ones an
 * fs mock papers over.
 */

// Hoisted: setup.ts constructs its HttpClient at module scope, so the mock
// factory runs before a plain `const` here would be initialized.
const { get } = vi.hoisted(() => ({ get: vi.fn() }))

vi.mock('@actions/http-client', () => ({
  HttpClient: class {
    get = get
  }
}))
vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
  getInput: vi.fn(() => ''),
  startGroup: vi.fn(),
  endGroup: vi.fn()
}))
// Sleep for real would make the exhaustion test a 17.5 s test.
vi.mock('timers/promises', () => ({ setTimeout: vi.fn(async () => undefined) }))

import * as core from '@actions/core'
import { setTimeout as sleep } from 'timers/promises'
import { downloadAsset, sha256File } from './setup'

const URL = 'https://github.com/code-cargo/cargowall/releases/download/v1.3.6/cargowall-linux-amd64'

/** A 2xx whose body streams cleanly. */
function respondOk(body = 'binary-bytes'): unknown {
  const message = Readable.from([body]) as Readable & { statusCode: number }
  message.statusCode = 200
  return { message }
}

/** A non-2xx. The body is drained, not written. */
function respondStatus(statusCode: number): unknown {
  const message = Readable.from(['<html>error</html>']) as Readable & { statusCode: number }
  message.statusCode = statusCode
  return { message }
}

/** A 2xx that dies partway through the body — the truncated-download case. */
function respondTruncated(): unknown {
  const message = new Readable({
    read() {
      this.push('half-a-')
      this.destroy(new Error('aborted'))
    }
  }) as Readable & { statusCode: number }
  message.statusCode = 200
  return { message }
}

const delays = (): number[] => vi.mocked(sleep).mock.calls.map(c => c[0] as number)
const retryLogs = (): string[] =>
  vi.mocked(core.info).mock.calls.map(c => String(c[0])).filter(m => m.includes('retrying in'))

let dir: string
let dest: string

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-download-'))
})

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('downloadAsset', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    dest = path.join(dir, `asset-${vi.mocked(get).mock.calls.length}-${process.hrtime.bigint()}`)
  })

  it('writes the body on a clean first attempt', async () => {
    get.mockResolvedValueOnce(respondOk())
    await downloadAsset(URL, dest)
    expect(await fs.readFile(dest, 'utf8')).toBe('binary-bytes')
    expect(get).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('survives a socket reset and logs the retry', async () => {
    get.mockRejectedValueOnce(new Error('socket hang up'))
    get.mockResolvedValueOnce(respondOk())

    await downloadAsset(URL, dest)

    expect(await fs.readFile(dest, 'utf8')).toBe('binary-bytes')
    expect(get).toHaveBeenCalledTimes(2)
    expect(retryLogs()).toEqual([
      expect.stringContaining('cargowall-linux-amd64 failed (socket hang up)')
    ])
    expect(retryLogs()[0]).toContain('attempt 2 of 5')
  })

  it('retries a 5xx', async () => {
    get.mockResolvedValueOnce(respondStatus(503))
    get.mockResolvedValueOnce(respondOk())

    await downloadAsset(URL, dest)

    expect(await fs.readFile(dest, 'utf8')).toBe('binary-bytes')
    expect(retryLogs()[0]).toContain('(HTTP 503)')
  })

  it('retries a 429 and a 408, which the old 5xx-only path let through', async () => {
    get.mockResolvedValueOnce(respondStatus(429))
    get.mockResolvedValueOnce(respondStatus(408))
    get.mockResolvedValueOnce(respondOk())

    await downloadAsset(URL, dest)

    expect(get).toHaveBeenCalledTimes(3)
  })

  it('discards a truncated body instead of leaving it for the checksum step', async () => {
    get.mockResolvedValueOnce(respondTruncated())
    get.mockResolvedValueOnce(respondOk())

    await downloadAsset(URL, dest)

    expect(await fs.readFile(dest, 'utf8')).toBe('binary-bytes')
  })

  it('never sends a token on the first attempt', async () => {
    get.mockResolvedValueOnce(respondOk())
    await downloadAsset(URL, dest, 'ghs-token')
    expect(get.mock.calls[0][1]).toBeUndefined()
  })

  it('escalates to an authenticated retry after a 503', async () => {
    get.mockResolvedValueOnce(respondStatus(503))
    get.mockResolvedValueOnce(respondOk())

    await downloadAsset(URL, dest, 'ghs-token')

    expect(get.mock.calls[1][1]).toEqual({ authorization: 'Bearer ghs-token' })
    expect(vi.mocked(core.info).mock.calls.map(c => String(c[0]))).toContainEqual(
      expect.stringContaining('hit HTTP 503 — retrying authenticated')
    )
  })

  it('escalates on a 403, which is otherwise fatal', async () => {
    get.mockResolvedValueOnce(respondStatus(403))
    get.mockResolvedValueOnce(respondOk())

    await downloadAsset(URL, dest, 'ghs-token')

    expect(get).toHaveBeenCalledTimes(2)
    expect(get.mock.calls[1][1]).toEqual({ authorization: 'Bearer ghs-token' })
  })

  it('fails fast on a 403 when there is no token to escalate with', async () => {
    get.mockResolvedValueOnce(respondStatus(403))

    await expect(downloadAsset(URL, dest)).rejects.toThrow('HTTP 403')
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('stops after one escalation — a second authenticated 403 is fatal', async () => {
    get.mockResolvedValue(respondStatus(403))

    await expect(downloadAsset(URL, dest, 'ghs-token')).rejects.toThrow('HTTP 403')
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('keeps the token attached for the remaining attempts', async () => {
    get.mockResolvedValueOnce(respondStatus(503))
    get.mockRejectedValueOnce(new Error('socket hang up'))
    get.mockResolvedValueOnce(respondOk())

    await downloadAsset(URL, dest, 'ghs-token')

    expect(get.mock.calls[2][1]).toEqual({ authorization: 'Bearer ghs-token' })
  })

  it('does not escalate on a single socket reset — one blip is incidental', async () => {
    get.mockRejectedValueOnce(new Error('socket hang up'))
    get.mockResolvedValueOnce(respondOk())

    await downloadAsset(URL, dest, 'ghs-token')

    expect(get.mock.calls[1][1]).toBeUndefined()
  })

  it('escalates after two consecutive socket resets — persistent transport failure', async () => {
    // 2026-08-12: five straight anonymous hang-ups killed a job while the
    // same throttle answered every authenticated attempt first try. Two
    // consecutive resets mean persistent, so the token goes on from there.
    get.mockRejectedValueOnce(new Error('socket hang up'))
    get.mockRejectedValueOnce(new Error('socket hang up'))
    get.mockResolvedValueOnce(respondOk())

    await downloadAsset(URL, dest, 'ghs-token')

    expect(get.mock.calls[1][1]).toBeUndefined()
    expect(get.mock.calls[2][1]).toEqual({ authorization: 'Bearer ghs-token' })
  })

  it('never escalates without a token, however persistent the resets', async () => {
    get.mockRejectedValue(new Error('socket hang up'))

    await expect(downloadAsset(URL, dest)).rejects.toThrow('after 5 attempts')
    for (const call of get.mock.calls) {
      expect(call[1]).toBeUndefined()
    }
  })

  it('does not retry a 404 — an unpublished tag will not heal', async () => {
    get.mockResolvedValueOnce(respondStatus(404))

    await expect(downloadAsset(URL, dest)).rejects.toThrow(`Failed to download ${URL}: HTTP 404`)
    expect(get).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('leaves nothing on disk when every attempt truncates', async () => {
    get.mockImplementation(async () => respondTruncated())

    await expect(downloadAsset(URL, dest)).rejects.toThrow('after 5 attempts')
    await expect(fs.access(dest)).rejects.toThrow()
  })

  it('gives up after five attempts, naming the asset URL', async () => {
    get.mockRejectedValue(new Error('socket hang up'))

    await expect(downloadAsset(URL, dest)).rejects.toThrow(
      `Failed to download ${URL} after 5 attempts: socket hang up`
    )
    expect(get).toHaveBeenCalledTimes(5)
    expect(retryLogs()).toHaveLength(4)
  })

  it('backs off ~0.5 s / 2 s / 5 s / 10 s with jitter', async () => {
    get.mockRejectedValue(new Error('ECONNRESET'))

    await expect(downloadAsset(URL, dest)).rejects.toThrow()

    const [first, second, third, fourth] = delays()
    expect(first).toBeGreaterThanOrEqual(250)
    expect(first).toBeLessThanOrEqual(750)
    expect(second).toBeGreaterThanOrEqual(1000)
    expect(second).toBeLessThanOrEqual(3000)
    expect(third).toBeGreaterThanOrEqual(2500)
    expect(third).toBeLessThanOrEqual(7500)
    // #79 follow-up: the tail has to outlive a sticky bad edge path (observed
    // >8 s on 2026-08-12), not just a dropped packet.
    expect(fourth).toBeGreaterThanOrEqual(5000)
    expect(fourth).toBeLessThanOrEqual(15000)
    // The logged wait is the one actually slept.
    expect(retryLogs()[0]).toContain(`retrying in ${first} ms`)
  })
})

/**
 * sha256File replaces the fetched checksums.txt as the checksum side of
 * verification — the expected value is pinned in setup.ts. Known NIST vectors,
 * plus a multi-chunk file to catch a hash that only sees the first read.
 */
describe('sha256File', () => {
  it('matches the known digest of the empty input', async () => {
    const p = path.join(dir, 'empty')
    await fs.writeFile(p, '')
    expect(await sha256File(p)).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    )
  })

  it('matches the known digest of "abc"', async () => {
    const p = path.join(dir, 'abc')
    await fs.writeFile(p, 'abc')
    expect(await sha256File(p)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
  })

  it('hashes a file larger than one stream chunk', async () => {
    const p = path.join(dir, 'large')
    // 4 MiB of zeros — several 64 KiB stream chunks.
    await fs.writeFile(p, Buffer.alloc(4 * 1024 * 1024))
    expect(await sha256File(p)).toBe(
      'bb9f8df61474d25e71fa00722318cd387396ca1736605e1248821cc0de3d3af8'
    )
  })
})
