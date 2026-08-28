import { describe, it, expect } from 'vitest'
import { parseWorkerSteps } from './diag'

const LOG = `[2026-08-06 18:23:40Z INFO HostContext] Well known directory 'Root': '/home/runner/actions-runner'
[2026-08-06 18:23:45Z INFO StepsRunner] Processing step: DisplayName='Run actions/checkout@v6'
[2026-08-06 18:23:46Z INFO ExecutionContext] Publish step telemetry for current step
[2026-08-06 18:23:51Z INFO StepsRunner] Processing step: DisplayName='Setup CargoWall'
[2026-08-06 18:24:12Z INFO StepsRunner] Processing step: DisplayName='Run tests'
[2026-08-06 18:25:03Z INFO StepsRunner] Processing step: DisplayName='Post Setup CargoWall'
`

describe('parseWorkerSteps', () => {
  it('extracts executed steps in order with RFC3339 start times from the trace prefix', () => {
    const steps = parseWorkerSteps(LOG)
    expect(steps.map(s => s.name)).toEqual([
      'Run actions/checkout@v6',
      'Setup CargoWall',
      'Run tests',
      'Post Setup CargoWall',
    ])
    expect(steps[0].started_at).toBe('2026-08-06T18:23:45Z')
    expect(steps[2].started_at).toBe('2026-08-06T18:24:12Z')
  })

  it('chains completed_at from the next step start, null on the last', () => {
    const steps = parseWorkerSteps(LOG)
    expect(steps[0].completed_at).toBe('2026-08-06T18:23:51Z')
    expect(steps[1].completed_at).toBe('2026-08-06T18:24:12Z')
    expect(steps[3].completed_at).toBeNull()
  })

  it('keeps fractional seconds when the runner emits them', () => {
    const steps = parseWorkerSteps(
      "[2026-08-06 18:23:45.1234567Z INFO StepsRunner] Processing step: DisplayName='Build'\n"
    )
    expect(steps).toEqual([
      { name: 'Build', started_at: '2026-08-06T18:23:45.1234567Z', completed_at: null },
    ])
  })

  it('keeps a step whose prefix does not parse, with a null start, without shifting later steps', () => {
    const steps = parseWorkerSteps(
      "Processing step: DisplayName='Oddly Prefixed'\n" +
        "[2026-08-06 18:24:00Z INFO StepsRunner] Processing step: DisplayName='Next'\n"
    )
    expect(steps).toEqual([
      { name: 'Oddly Prefixed', started_at: null, completed_at: '2026-08-06T18:24:00Z' },
      { name: 'Next', started_at: '2026-08-06T18:24:00Z', completed_at: null },
    ])
  })

  it('ignores unrelated lines and empty content', () => {
    expect(parseWorkerSteps('')).toEqual([])
    expect(parseWorkerSteps('[2026-08-06 18:23:40Z INFO Worker] Job completed\n')).toEqual([])
  })
})
