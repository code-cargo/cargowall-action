import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import * as path from 'path'
import * as os from 'os'
import { parseBlockFilename, readBlockTimestamp, scanBlocksDir } from './blocks'

describe('parseBlockFilename', () => {
  it('extracts step ID from standard filename', () => {
    expect(parseBlockFilename('abc123_step-id-here.0')).toBe('step-id-here')
  })

  it('handles GUID-style IDs', () => {
    expect(parseBlockFilename('a1b2c3d4-e5f6_09cdfd60-4197-561a-ba49-f68044947970.0'))
      .toBe('09cdfd60-4197-561a-ba49-f68044947970')
  })

  it('returns null for no underscore', () => {
    expect(parseBlockFilename('nounderscorehere.0')).toBeNull()
  })

  it('extracts step ID when there is no dot (no page)', () => {
    expect(parseBlockFilename('job_step')).toBe('step')
  })

  it('returns null for empty step ID after underscore', () => {
    expect(parseBlockFilename('job_.0')).toBeNull()
  })

  it('handles multiple pages', () => {
    expect(parseBlockFilename('job_step.0')).toBe('step')
    expect(parseBlockFilename('job_step.1')).toBe('step')
    expect(parseBlockFilename('job_step.12')).toBe('step')
  })
})

describe('readBlockTimestamp', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blocks-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true })
  })

  it('extracts timestamp from first line', async () => {
    const file = path.join(tmpDir, 'test.0')
    await fs.writeFile(file, '2026-03-30T17:06:06.6048001Z some log content\nmore lines\n')
    expect(await readBlockTimestamp(file)).toBe('2026-03-30T17:06:06.6048001Z')
  })

  it('handles BOM prefix', async () => {
    const file = path.join(tmpDir, 'test.0')
    await fs.writeFile(file, '\uFEFF2026-03-30T18:54:31.0140389Z content\n')
    expect(await readBlockTimestamp(file)).toBe('2026-03-30T18:54:31.0140389Z')
  })

  it('returns null for empty file', async () => {
    const file = path.join(tmpDir, 'test.0')
    await fs.writeFile(file, '')
    expect(await readBlockTimestamp(file)).toBeNull()
  })

  it('returns null when first line has no timestamp', async () => {
    const file = path.join(tmpDir, 'test.0')
    await fs.writeFile(file, 'no timestamp here\n2026-03-30T17:00:00.000Z on second line\n')
    expect(await readBlockTimestamp(file)).toBeNull()
  })

  it('only reads first line', async () => {
    const file = path.join(tmpDir, 'test.0')
    await fs.writeFile(file, 'not a timestamp\n2026-03-30T17:00:00.000Z\n')
    expect(await readBlockTimestamp(file)).toBeNull()
  })
})

describe('scanBlocksDir', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blocks-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true })
  })

  it('scans block files and returns step timestamps', async () => {
    await fs.writeFile(path.join(tmpDir, 'job_stepA.0'), '2026-03-30T10:00:00.100Z log\n')
    await fs.writeFile(path.join(tmpDir, 'job_stepB.0'), '2026-03-30T10:00:01.200Z log\n')

    const results = await scanBlocksDir(tmpDir)
    expect(results).toHaveLength(2)
    expect(results.find(r => r.id === 'stepA')?.ts).toBe('2026-03-30T10:00:00.100Z')
    expect(results.find(r => r.id === 'stepB')?.ts).toBe('2026-03-30T10:00:01.200Z')
  })

  it('deduplicates by step ID — uses earliest timestamp across pages', async () => {
    await fs.writeFile(path.join(tmpDir, 'job_step1.0'), '2026-03-30T10:00:00.000Z first page\n')
    await fs.writeFile(path.join(tmpDir, 'job_step1.1'), '2026-03-30T10:00:05.000Z later page\n')

    const results = await scanBlocksDir(tmpDir)
    expect(results).toHaveLength(1)
    expect(results[0].ts).toBe('2026-03-30T10:00:00.000Z')
  })

  it('handles numeric page sort correctly (.10 vs .2)', async () => {
    // .10 sorts before .2 lexicographically, but .2 has the earlier timestamp
    await fs.writeFile(path.join(tmpDir, 'job_step1.10'), '2026-03-30T10:00:50.000Z page 10\n')
    await fs.writeFile(path.join(tmpDir, 'job_step1.2'), '2026-03-30T10:00:02.000Z page 2\n')

    const results = await scanBlocksDir(tmpDir)
    expect(results).toHaveLength(1)
    expect(results[0].ts).toBe('2026-03-30T10:00:02.000Z')
  })

  it('skips files without underscore', async () => {
    await fs.writeFile(path.join(tmpDir, 'nounderscore.0'), '2026-03-30T10:00:00.000Z\n')
    await fs.writeFile(path.join(tmpDir, 'job_valid.0'), '2026-03-30T10:00:01.000Z\n')

    const results = await scanBlocksDir(tmpDir)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('valid')
  })

  it('skips files with no timestamp match', async () => {
    await fs.writeFile(path.join(tmpDir, 'job_step1.0'), 'no timestamp\n')
    await fs.writeFile(path.join(tmpDir, 'job_step2.0'), '2026-03-30T10:00:00.000Z\n')

    const results = await scanBlocksDir(tmpDir)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('step2')
  })

  it('returns empty for empty directory', async () => {
    const results = await scanBlocksDir(tmpDir)
    expect(results).toHaveLength(0)
  })
})
