import { describe, it, expect, vi, beforeEach } from 'vitest'
import { enhanceApiStepsWithDiag, buildStepsFromDiag, shouldCallActionsApi, type DiagData, type StepEntry } from './summary'

// Mock @actions/core — buildStepsFromDiag calls core.getState and core.info
vi.mock('@actions/core', () => ({
  getState: vi.fn(),
  info: vi.fn(),
}))

import * as core from '@actions/core'

function makeDiag(overrides: Partial<DiagData> = {}): DiagData {
  return {
    planStepIds: new Set(),
    planSteps: [],
    tsEntries: [],
    executedNames: [],
    ...overrides,
  }
}

describe('enhanceApiStepsWithDiag', () => {
  it('returns API steps unchanged when no _diag timestamps', () => {
    const apiSteps: StepEntry[] = [
      { name: 'Set up job', started_at: '2026-03-30T10:00:00Z', completed_at: '2026-03-30T10:00:01Z' },
      { name: 'Build', started_at: '2026-03-30T10:00:01Z', completed_at: null },
    ]
    const result = enhanceApiStepsWithDiag(apiSteps, makeDiag())
    expect(result).toEqual(apiSteps)
  })

  it('replaces API timestamps with sub-second _diag timestamps', () => {
    const apiSteps: StepEntry[] = [
      { name: 'Set up job', started_at: '2026-03-30T10:00:00Z', completed_at: '2026-03-30T10:00:01Z' },
      { name: 'Build', started_at: '2026-03-30T10:00:01Z', completed_at: '2026-03-30T10:00:05Z' },
      { name: 'Test', started_at: '2026-03-30T10:00:05Z', completed_at: null },
    ]
    const diag = makeDiag({
      planSteps: [['id-build', 'Build'], ['id-test', 'Test']],
      tsEntries: [
        { id: 'id-build', ts: '2026-03-30T10:00:01.5000000Z' },
        { id: 'id-test', ts: '2026-03-30T10:00:05.2500000Z' },
      ],
    })

    const result = enhanceApiStepsWithDiag(apiSteps, diag)

    // "Set up job" completed_at should be updated to Build's sub-second start
    expect(result[0].completed_at).toBe('2026-03-30T10:00:01.5000000Z')
    // Build should have sub-second started_at
    expect(result[1].started_at).toBe('2026-03-30T10:00:01.5000000Z')
    // Build completed_at should be updated to Test's sub-second start
    expect(result[1].completed_at).toBe('2026-03-30T10:00:05.2500000Z')
    // Test should have sub-second started_at
    expect(result[2].started_at).toBe('2026-03-30T10:00:05.2500000Z')
  })

  it('maintains positional alignment when some plan steps lack watcher data', () => {
    const apiSteps: StepEntry[] = [
      { name: 'Set up job', started_at: '2026-03-30T10:00:00Z', completed_at: '2026-03-30T10:00:01Z' },
      { name: 'Step A', started_at: '2026-03-30T10:00:01Z', completed_at: '2026-03-30T10:00:02Z' },
      { name: 'Step B', started_at: '2026-03-30T10:00:02Z', completed_at: '2026-03-30T10:00:03Z' },
      { name: 'Step C', started_at: '2026-03-30T10:00:03Z', completed_at: null },
    ]
    // Watcher has data for A and C but not B
    const diag = makeDiag({
      planSteps: [['id-a', 'A'], ['id-b', 'B'], ['id-c', 'C']],
      tsEntries: [
        { id: 'id-a', ts: '2026-03-30T10:00:01.1000000Z' },
        { id: 'id-c', ts: '2026-03-30T10:00:03.3000000Z' },
      ],
    })

    const result = enhanceApiStepsWithDiag(apiSteps, diag)

    // A enhanced
    expect(result[1].started_at).toBe('2026-03-30T10:00:01.1000000Z')
    // B not enhanced — kept original API timestamp
    expect(result[2].started_at).toBe('2026-03-30T10:00:02Z')
    // C enhanced
    expect(result[3].started_at).toBe('2026-03-30T10:00:03.3000000Z')
  })

  it('fixes timestamp inversions at enhancement boundary', () => {
    const apiSteps: StepEntry[] = [
      { name: 'Set up job', started_at: '2026-03-30T10:00:00Z', completed_at: '2026-03-30T10:00:01Z' },
      { name: 'Step A', started_at: '2026-03-30T10:00:01Z', completed_at: '2026-03-30T10:00:02Z' },
      { name: 'Step B', started_at: '2026-03-30T10:00:02Z', completed_at: '2026-03-30T10:00:02Z' },
    ]
    // Only A has watcher data. Its sub-second started_at will be set,
    // and A's completed_at should come from B's started_at (API: 10:00:02Z).
    // But the enhancement sets A's completed_at from B's watcher ts... B has none.
    // So A keeps API completed_at. If A's enhanced started_at > API completed_at, inversion.
    const diag = makeDiag({
      planSteps: [['id-a', 'A'], ['id-b', 'B']],
      tsEntries: [
        { id: 'id-a', ts: '2026-03-30T10:00:01.9990000Z' },
      ],
    })

    const result = enhanceApiStepsWithDiag(apiSteps, diag)

    // A's started_at is sub-second (after the second boundary)
    expect(result[1].started_at).toBe('2026-03-30T10:00:01.9990000Z')
    // A's completed_at was API 10:00:02Z — not inverted (1.999 < 2.000)
    expect(result[1].completed_at).toBe('2026-03-30T10:00:02Z')

    // Now test actual inversion: sub-second started_at AFTER second-precision completed_at
    const apiSteps2: StepEntry[] = [
      { name: 'Set up job', started_at: '2026-03-30T10:00:00Z', completed_at: '2026-03-30T10:00:01Z' },
      { name: 'Step A', started_at: '2026-03-30T10:00:01Z', completed_at: '2026-03-30T10:00:01Z' },
    ]
    const diag2 = makeDiag({
      planSteps: [['id-a', 'A']],
      tsEntries: [{ id: 'id-a', ts: '2026-03-30T10:00:01.5000000Z' }],
    })

    const result2 = enhanceApiStepsWithDiag(apiSteps2, diag2)
    // started_at (1.5) > completed_at (1.0) — inversion should be cleared
    expect(result2[1].started_at).toBe('2026-03-30T10:00:01.5000000Z')
    expect(result2[1].completed_at).toBeNull()
  })
})

describe('buildStepsFromDiag', () => {
  beforeEach(() => {
    vi.mocked(core.getState).mockReturnValue('')
  })

  it('returns empty when no watcher entries', () => {
    const result = buildStepsFromDiag(makeDiag())
    expect(result).toEqual([])
  })

  it('builds steps with correct names from ID→name mapping', () => {
    vi.mocked(core.getState).mockReturnValue('Setup CW')

    const diag = makeDiag({
      planStepIds: new Set(['id-setup', 'id-test']),
      planSteps: [['id-setup', 'internal1'], ['id-test', 'internal2']],
      tsEntries: [
        { id: 'id-setup', ts: '2026-03-30T10:00:01.000Z' },
        { id: 'id-test', ts: '2026-03-30T10:00:05.000Z' },
      ],
      executedNames: ['Setup CW', 'Run tests'],
    })

    const result = buildStepsFromDiag(diag)
    expect(result).toHaveLength(2)
    expect(result[0].name).toBe('Setup CW')
    expect(result[0].started_at).toBe('2026-03-30T10:00:01.000Z')
    expect(result[0].completed_at).toBe('2026-03-30T10:00:05.000Z')
    expect(result[1].name).toBe('Run tests')
    expect(result[1].started_at).toBe('2026-03-30T10:00:05.000Z')
    expect(result[1].completed_at).toBeNull()
  })

  it('skips pre-CW steps using cw-step-name', () => {
    vi.mocked(core.getState).mockReturnValue('Setup CW')

    const diag = makeDiag({
      planStepIds: new Set(['id-checkout', 'id-setup', 'id-test']),
      planSteps: [['id-checkout', 'co'], ['id-setup', 'setup'], ['id-test', 'test']],
      tsEntries: [
        { id: 'id-checkout', ts: '2026-03-30T10:00:00.000Z' },
        { id: 'id-setup', ts: '2026-03-30T10:00:01.000Z' },
        { id: 'id-test', ts: '2026-03-30T10:00:05.000Z' },
      ],
      executedNames: ['Run actions/checkout@v6', 'Setup CW', 'Run tests'],
    })

    const result = buildStepsFromDiag(diag)
    expect(result).toHaveLength(2)
    expect(result[0].name).toBe('Setup CW')
    expect(result[1].name).toBe('Run tests')
  })

  it('handles skipped steps (if: condition) — names stay aligned', () => {
    vi.mocked(core.getState).mockReturnValue('Step A')

    // Plan has A, B, C. Only A and C executed (B was skipped via if:).
    // Watcher only has entries for A and C.
    const diag = makeDiag({
      planStepIds: new Set(['id-a', 'id-b', 'id-c']),
      planSteps: [['id-a', 'a'], ['id-b', 'b'], ['id-c', 'c']],
      tsEntries: [
        { id: 'id-a', ts: '2026-03-30T10:00:01.000Z' },
        { id: 'id-c', ts: '2026-03-30T10:00:03.000Z' },
      ],
      executedNames: ['Step A', 'Step C'],
    })

    const result = buildStepsFromDiag(diag)
    expect(result).toHaveLength(2)
    expect(result[0].name).toBe('Step A')
    expect(result[1].name).toBe('Step C')
  })

  it('handles CW step missing from watcher (block file cleaned up)', () => {
    vi.mocked(core.getState).mockReturnValue('Setup CW')

    // CW step (id-setup) has no watcher entry — block file was cleaned up.
    // Checkout has a watcher entry but is pre-CW.
    const diag = makeDiag({
      planStepIds: new Set(['id-checkout', 'id-setup', 'id-test1', 'id-test2']),
      planSteps: [['id-checkout', 'co'], ['id-setup', 'setup'], ['id-test1', 't1'], ['id-test2', 't2']],
      tsEntries: [
        { id: 'id-bookend', ts: '2026-03-30T10:00:00.000Z' }, // Set up job
        { id: 'id-checkout', ts: '2026-03-30T10:00:01.000Z' },
        // id-setup MISSING — block cleaned up
        { id: 'id-test1', ts: '2026-03-30T10:00:10.000Z' },
        { id: 'id-test2', ts: '2026-03-30T10:00:11.000Z' },
      ],
      executedNames: ['Run actions/checkout@v6', 'Setup CW', 'Test 1', 'Test 2'],
    })

    const result = buildStepsFromDiag(diag)
    // Should start from test1 (next step after missing CW step), with correct names
    expect(result).toHaveLength(2)
    expect(result[0].name).toBe('Test 1')
    expect(result[0].started_at).toBe('2026-03-30T10:00:10.000Z')
    expect(result[1].name).toBe('Test 2')
  })

  it('includes post steps with names from Worker log', () => {
    vi.mocked(core.getState).mockReturnValue('Setup CW')

    const diag = makeDiag({
      planStepIds: new Set(['id-setup', 'id-test']),
      planSteps: [['id-setup', 'setup'], ['id-test', 'test']],
      tsEntries: [
        { id: 'id-setup', ts: '2026-03-30T10:00:01.000Z' },
        { id: 'id-test', ts: '2026-03-30T10:00:05.000Z' },
        { id: 'id-post', ts: '2026-03-30T10:00:06.000Z' },
      ],
      executedNames: ['Setup CW', 'Run tests', 'Post Setup CW'],
    })

    const result = buildStepsFromDiag(diag)
    expect(result).toHaveLength(3)
    expect(result[2].name).toBe('Post Setup CW')
    expect(result[2].started_at).toBe('2026-03-30T10:00:06.000Z')
  })

  it('chains completed_at to next step started_at', () => {
    vi.mocked(core.getState).mockReturnValue('A')

    const diag = makeDiag({
      planStepIds: new Set(['id-a', 'id-b', 'id-c']),
      planSteps: [['id-a', 'a'], ['id-b', 'b'], ['id-c', 'c']],
      tsEntries: [
        { id: 'id-a', ts: '2026-03-30T10:00:01.000Z' },
        { id: 'id-b', ts: '2026-03-30T10:00:02.000Z' },
        { id: 'id-c', ts: '2026-03-30T10:00:03.000Z' },
      ],
      executedNames: ['A', 'B', 'C'],
    })

    const result = buildStepsFromDiag(diag)
    expect(result[0].completed_at).toBe('2026-03-30T10:00:02.000Z')
    expect(result[1].completed_at).toBe('2026-03-30T10:00:03.000Z')
    expect(result[2].completed_at).toBeNull()
  })

  it('skips Set up job bookend entries', () => {
    vi.mocked(core.getState).mockReturnValue('Setup CW')

    const diag = makeDiag({
      planStepIds: new Set(['id-setup']),
      planSteps: [['id-setup', 'setup']],
      tsEntries: [
        { id: 'id-bookend', ts: '2026-03-30T10:00:00.000Z' }, // not in plan
        { id: 'id-setup', ts: '2026-03-30T10:00:01.000Z' },
      ],
      executedNames: ['Setup CW'],
    })

    const result = buildStepsFromDiag(diag)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Setup CW')
  })
})

describe('shouldCallActionsApi', () => {
  const baseArgs = {
    token: 'tok',
    runId: 123,
    skipInput: 'false',
    skipEnv: undefined as string | undefined,
  }

  it('returns true with token + runId and both skip flags off', () => {
    expect(shouldCallActionsApi(baseArgs)).toBe(true)
  })

  it('returns false when token is empty', () => {
    expect(shouldCallActionsApi({ ...baseArgs, token: '' })).toBe(false)
  })

  it('returns false when runId is 0', () => {
    expect(shouldCallActionsApi({ ...baseArgs, runId: 0 })).toBe(false)
  })

  it('returns false when skip-actions-api input is "true" even with token present', () => {
    expect(shouldCallActionsApi({ ...baseArgs, skipInput: 'true' })).toBe(false)
  })

  it('returns false when CARGOWALL_SKIP_ACTIONS_API env var is "true"', () => {
    expect(shouldCallActionsApi({ ...baseArgs, skipEnv: 'true' })).toBe(false)
  })

  it('env var still skips when input is "false" (env override preserved)', () => {
    expect(shouldCallActionsApi({ ...baseArgs, skipInput: 'false', skipEnv: 'true' })).toBe(false)
  })

  it('only the literal string "true" skips — other truthy-looking values do not', () => {
    expect(shouldCallActionsApi({ ...baseArgs, skipInput: '1' })).toBe(true)
    expect(shouldCallActionsApi({ ...baseArgs, skipInput: 'TRUE' })).toBe(true)
    expect(shouldCallActionsApi({ ...baseArgs, skipEnv: 'yes' })).toBe(true)
  })
})
