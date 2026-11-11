import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'fs'
import { execFileSync } from 'child_process'
import * as os from 'os'
import * as path from 'path'
import { readStateFile, stateFileOwner } from './start'

/**
 * Real-filesystem tests for readStateFile — deliberately NO fs mocks, because
 * the properties under test are exactly the ones a mock papers over:
 *
 * - a planted FIFO must not hang the read (open(2) with O_RDONLY on a FIFO
 *   blocks until a writer appears; O_NOFOLLOW does not change that, so the
 *   lstat-first ordering and O_NONBLOCK are load-bearing)
 * - a planted symlink must not be followed
 * - an oversized file must not be slurped
 *
 * The tight test timeouts are the assertion for the hang cases: a regression
 * to an open-first blocking read fails these by timeout.
 */

let dir: string

// cargowall's files are root's; these tests can't chown, so the files they
// write stand in for root's by making their own uid the owner to accept.
const rootUid = stateFileOwner.uid

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-statefile-'))
  stateFileOwner.uid = process.getuid!()
})

afterAll(async () => {
  stateFileOwner.uid = rootUid
  await fs.rm(dir, { recursive: true, force: true })
})

describe('readStateFile (real fs)', () => {
  it('reads a regular file', async () => {
    const p = path.join(dir, 'regular')
    await fs.writeFile(p, 'pid=1\nreason\n')
    expect(await readStateFile(p)).toBe('pid=1\nreason\n')
  })

  it('returns null for an absent file', async () => {
    expect(await readStateFile(path.join(dir, 'missing'))).toBeNull()
  })

  it('rejects a planted FIFO without hanging', { timeout: 2000 }, async () => {
    const p = path.join(dir, 'fifo')
    execFileSync('mkfifo', [p])
    expect(await readStateFile(p)).toBeNull()
  })

  it('refuses to follow a planted symlink', { timeout: 2000 }, async () => {
    const target = path.join(dir, 'target')
    await fs.writeFile(target, 'secret')
    const link = path.join(dir, 'link')
    await fs.symlink(target, link)
    expect(await readStateFile(link)).toBeNull()
  })

  it('bounds the read of an oversized file to 8 KiB', async () => {
    const p = path.join(dir, 'huge')
    await fs.writeFile(p, 'x'.repeat(64 * 1024))
    const result = await readStateFile(p)
    expect(result).not.toBeNull()
    expect(result!.length).toBe(8192)
  })

  it("ignores a file another user planted, however well-formed", async () => {
    const p = path.join(dir, 'planted')
    await fs.writeFile(p, 'enforce')
    stateFileOwner.uid = process.getuid!() + 1
    try {
      expect(await readStateFile(p)).toBeNull()
    } finally {
      stateFileOwner.uid = process.getuid!()
    }
  })
})
