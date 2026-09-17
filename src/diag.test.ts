import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('fs', () => ({
  promises: {
    readFile: vi.fn(),
    readlink: vi.fn(),
  },
}))

import { promises as fsp } from 'fs'
import { findRunnerRootFromAncestry, parsePpid, parseWorkerSteps, runnerRootFromExe } from './diag'

/** One /proc entry per pid, as the ancestry walk reads them. */
type ProcEntry = { comm: string; ppid: number; exe?: string }

/**
 * Stand /proc up from a pid table so the walk can be driven end to end.
 * An unlisted pid reads ENOENT, and a pid with no `exe` has an unreadable
 * exe link — both of the ways the real thing goes quiet.
 */
function withProc(table: Record<number, ProcEntry>): void {
  const pidOf = (p: string): number => Number(p.split('/')[2])
  vi.mocked(fsp.readFile).mockImplementation((async (p: string) => {
    const entry = table[pidOf(p)]
    if (!entry) throw new Error('ENOENT')
    if (p.endsWith('/comm')) return `${entry.comm}\n`
    if (p.endsWith('/stat')) return `${pidOf(p)} (${entry.comm}) S ${entry.ppid} 0 0 0 -1 4194560 100`
    throw new Error('ENOENT')
  }) as unknown as typeof fsp.readFile)
  vi.mocked(fsp.readlink).mockImplementation((async (p: string) => {
    const exe = table[pidOf(p)]?.exe
    if (!exe) throw new Error('EACCES')
    return exe
  }) as unknown as typeof fsp.readlink)
}

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

describe('parsePpid', () => {
  it('reads the field after the parenthesised comm', () => {
    expect(parsePpid('1234 (node) S 1200 1234 1234 0 -1 4194560 100')).toBe(1200)
  })

  it('survives spaces and parentheses inside comm', () => {
    expect(parsePpid('77 (Runner.Worker (x) y) S 42 77 77 0 -1')).toBe(42)
  })

  it('returns null for malformed input', () => {
    expect(parsePpid('garbage')).toBeNull()
    expect(parsePpid('1 (x) S')).toBeNull()
  })
})

describe('runnerRootFromExe', () => {
  it('maps the hosted-runner layout to the versioned root', () => {
    expect(runnerRootFromExe('/home/runner/actions-runner/cached/2.337.0/bin/Runner.Worker'))
      .toBe('/home/runner/actions-runner/cached/2.337.0')
  })

  it('maps the ARC image layout to /home/runner', () => {
    expect(runnerRootFromExe('/home/runner/bin/Runner.Worker')).toBe('/home/runner')
  })
})

describe('findRunnerRootFromAncestry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('walks past the shell and node to Runner.Worker on an ARC image', async () => {
    // The real chain in an ARC pod: the action's node under the step's bash
    // under the worker, whose exe is <root>/bin/Runner.Worker.
    withProc({
      500: { comm: 'node', ppid: 400 },
      400: { comm: 'bash', ppid: 300 },
      300: { comm: 'Runner.Worker', ppid: 200, exe: '/home/runner/bin/Runner.Worker' },
      200: { comm: 'Runner.Listener', ppid: 1, exe: '/home/runner/bin/Runner.Listener' },
    })
    await expect(findRunnerRootFromAncestry(500)).resolves.toBe('/home/runner')
  })

  it('resolves the versioned root on a hosted runner', async () => {
    withProc({
      90: { comm: 'node', ppid: 80 },
      80: {
        comm: 'Runner.Worker',
        ppid: 1,
        exe: '/home/runner/actions-runner/cached/2.337.0/bin/Runner.Worker',
      },
    })
    await expect(findRunnerRootFromAncestry(90))
      .resolves.toBe('/home/runner/actions-runner/cached/2.337.0')
  })

  it('stops at Runner.Listener when the worker is not in the chain', async () => {
    withProc({
      70: { comm: 'node', ppid: 60 },
      60: { comm: 'Runner.Listener', ppid: 1, exe: '/home/runner/bin/Runner.Listener' },
    })
    await expect(findRunnerRootFromAncestry(70)).resolves.toBe('/home/runner')
  })

  it('returns null when the runner exe link cannot be read', async () => {
    withProc({
      50: { comm: 'node', ppid: 40 },
      40: { comm: 'Runner.Worker', ppid: 1 },
    })
    await expect(findRunnerRootFromAncestry(50)).resolves.toBeNull()
  })

  it('returns null when the chain ends without a runner — a container job', async () => {
    withProc({
      30: { comm: 'node', ppid: 20 },
      20: { comm: 'docker-init', ppid: 1 },
    })
    await expect(findRunnerRootFromAncestry(30)).resolves.toBeNull()
  })

  it('returns null without /proc at all instead of throwing', async () => {
    withProc({})
    await expect(findRunnerRootFromAncestry(1234)).resolves.toBeNull()
    await expect(findRunnerRootFromAncestry(1)).resolves.toBeNull()
  })
})
