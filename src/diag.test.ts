import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import * as path from 'path'
import * as os from 'os'
import { parseJobPlan, parseExecutedSteps } from './diag'

describe('parseJobPlan', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'diag-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true })
  })

  it('extracts step IDs and display names from Worker log', async () => {
    const logContent = `[2026-03-30 INFO] Starting job
[2026-03-30 INFO] Body: {
  "steps": [
    { "id": "step-1", "name": "__self", "displayName": "Setup CargoWall" },
    { "id": "step-2", "name": "__run", "displayName": "Run tests" }
  ]
}
[2026-03-30 INFO] Done`
    await fs.writeFile(path.join(tmpDir, 'Worker_20260330.log'), logContent)

    const plan = await parseJobPlan(tmpDir)
    expect(Object.keys(plan)).toHaveLength(2)
    expect(plan['step-1']).toBe('Setup CargoWall')
    expect(plan['step-2']).toBe('Run tests')
  })

  it('prefers displayName over name', async () => {
    const logContent = `"steps": [
    { "id": "s1", "name": "internal", "displayName": "User Visible Name" }
  ]`
    await fs.writeFile(path.join(tmpDir, 'Worker_1.log'), logContent)

    const plan = await parseJobPlan(tmpDir)
    expect(plan['s1']).toBe('User Visible Name')
  })

  it('falls back to name when displayName is missing', async () => {
    const logContent = `"steps": [
    { "id": "s1", "name": "fallback-name" }
  ]`
    await fs.writeFile(path.join(tmpDir, 'Worker_1.log'), logContent)

    const plan = await parseJobPlan(tmpDir)
    expect(plan['s1']).toBe('fallback-name')
  })

  it('returns empty for no Worker logs', async () => {
    const plan = await parseJobPlan(tmpDir)
    expect(Object.keys(plan)).toHaveLength(0)
  })

  it('returns empty when no steps array found', async () => {
    await fs.writeFile(path.join(tmpDir, 'Worker_1.log'), 'no steps here\n')
    const plan = await parseJobPlan(tmpDir)
    expect(Object.keys(plan)).toHaveLength(0)
  })

  it('falls back to regex on malformed JSON', async () => {
    // Incomplete JSON that won't parse but has extractable data
    const logContent = `"steps": [
    { "id": "s1", "displayName": "Step One" },
    { "id": "s2", "name": "Step Two"
  ]`
    await fs.writeFile(path.join(tmpDir, 'Worker_1.log'), logContent)

    const plan = await parseJobPlan(tmpDir)
    // Regex fallback should extract at least some entries
    expect(Object.keys(plan).length).toBeGreaterThan(0)
  })

  it('uses latest Worker log when multiple exist', async () => {
    await fs.writeFile(path.join(tmpDir, 'Worker_1.log'), '"steps": [{ "id": "old", "name": "Old" }]')
    await fs.writeFile(path.join(tmpDir, 'Worker_2.log'), '"steps": [{ "id": "new", "name": "New" }]')

    const plan = await parseJobPlan(tmpDir)
    expect(plan['new']).toBe('New')
    expect(plan['old']).toBeUndefined()
  })
})

describe('parseExecutedSteps', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'diag-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true })
  })

  it('extracts step names in execution order', async () => {
    const logContent = `[INFO] Processing step: DisplayName='Run actions/checkout@v6'
[INFO] Starting the step.
[INFO] Step result: Succeeded
[INFO] Processing step: DisplayName='Setup CargoWall'
[INFO] Starting the step.
[INFO] Processing step: DisplayName='Run tests'`
    await fs.writeFile(path.join(tmpDir, 'Worker_1.log'), logContent)

    const names = await parseExecutedSteps(tmpDir)
    expect(names).toEqual([
      'Run actions/checkout@v6',
      'Setup CargoWall',
      'Run tests',
    ])
  })

  it('includes post steps', async () => {
    const logContent = `[INFO] Processing step: DisplayName='Setup CargoWall'
[INFO] Processing step: DisplayName='Run tests'
[INFO] Processing step: DisplayName='Post Setup CargoWall'`
    await fs.writeFile(path.join(tmpDir, 'Worker_1.log'), logContent)

    const names = await parseExecutedSteps(tmpDir)
    expect(names).toEqual(['Setup CargoWall', 'Run tests', 'Post Setup CargoWall'])
  })

  it('returns empty for no Worker logs', async () => {
    const names = await parseExecutedSteps(tmpDir)
    expect(names).toEqual([])
  })

  it('returns empty when no Processing step entries', async () => {
    await fs.writeFile(path.join(tmpDir, 'Worker_1.log'), 'some other log content\n')
    const names = await parseExecutedSteps(tmpDir)
    expect(names).toEqual([])
  })
})
