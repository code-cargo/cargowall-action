import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('fs', () => ({
  promises: {
    readFile: vi.fn(),
    readlink: vi.fn(),
    access: vi.fn(),
    readdir: vi.fn(),
  },
}))

import { promises as fsp } from 'fs'
import {
  findDiagDir,
  findRunnerRootFromAncestry,
  parsePpid,
  parseWorkerSteps,
  runnerRootFromExe,
} from './diag'

/**
 * One /proc entry per pid, as the ancestry walk reads them. `exe` is what
 * the walk matches on; `comm` only lands in the stat line, which is where
 * it belongs — a test that passes with a misleading comm is the point.
 */
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
    if (!entry || !p.endsWith('/stat')) throw new Error('ENOENT')
    return `${pidOf(p)} (${entry.comm}) S ${entry.ppid} 0 0 0 -1 4194560 100`
  }) as unknown as typeof fsp.readFile)
  vi.mocked(fsp.readlink).mockImplementation((async (p: string) => {
    const exe = table[pidOf(p)]?.exe
    if (!exe) throw new Error('EACCES')
    return exe
  }) as unknown as typeof fsp.readlink)
}

/** The directories that exist, plus the entries each readable one lists. */
function withPaths(accessible: string[], dirs: Record<string, string[]> = {}): void {
  const present = new Set(accessible)
  vi.mocked(fsp.access).mockImplementation((async (p: string) => {
    if (!present.has(p)) throw new Error('ENOENT')
  }) as unknown as typeof fsp.access)
  vi.mocked(fsp.readdir).mockImplementation((async (p: string) => {
    const names = dirs[p]
    if (!names) throw new Error('ENOENT')
    return names.map(name => ({ name, isDirectory: () => true }))
  }) as unknown as typeof fsp.readdir)
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

// The records a hosted runner (2.338.2) writes per step, as its Worker log
// has them: a Processing line, then, for a step whose if: is false, a
// Skipping line, or, for one that ran, its telemetry when it finishes.
const at = (s: number): string => `[2026-11-06 20:10:${String(s).padStart(2, '0')}Z INFO`
const processing = (s: number, name: string): string => `${at(s)} StepsRunner] Processing step: DisplayName='${name}'`
const skipping = (s: number): string =>
  [
    `${at(s)} StepsRunner] Evaluating: (success() && false)`,
    `${at(s)} StepsRunner] Result: false`,
    `${at(s)} StepsRunner] Skipping step due to condition evaluation.`,
  ].join('\n')
const telemetry = (s: number, fields: Record<string, unknown>): string =>
  [
    `${at(s)} StepsRunner] Step result: `,
    `${at(s)} ExecutionContext] Publish step telemetry for current step ${JSON.stringify(
      { result: 'succeeded', errorMessages: [], ...fields },
      null,
      2
    )}.`,
    `${at(s)} StepsRunner] Current state: job state = ''`,
  ].join('\n')
const main = (s: number, context: string, extra: Record<string, unknown> = {}): string =>
  telemetry(s, { action: 'sh', type: 'run', stage: 'Main', stepContextName: context, ...extra })

const JOB = [
  processing(1, 'Pre Remote with pre and post'),
  telemetry(1, { action: 'code-cargo/plan-prepost', type: 'node24', stage: 'Pre' }),
  processing(1, 'Run actions/checkout@v6'),
  main(2, '__actions_checkout', { action: 'actions/checkout', hasPreStep: false, hasPostStep: true }),
  processing(2, 'Start CargoWall'),
  main(3, '__code-cargo_cargowall-action', { action: 'code-cargo/cargowall-action', hasPostStep: true }),
  processing(3, 'Named step'),
  main(3, 'named'),
  processing(3, 'Skipped step'),
  skipping(3),
  processing(3, 'Same name'),
  main(3, '__run_3'),
  processing(3, 'Same name'),
  main(3, '__run_4'),
  processing(3, 'Composite'),
  telemetry(3, { action: 'bash', type: 'run', stage: 'Main', stepContextName: 'composite.__run', isEmbedded: true }),
  telemetry(3, { action: 'bash', type: 'run', stage: 'Main', stepContextName: 'composite.__run_2', isEmbedded: true }),
  main(3, 'composite', { type: 'composite', hasPreStep: false, hasPostStep: false }),
  processing(3, 'Remote with pre and post'),
  main(4, 'prepost', { type: 'node24', hasPreStep: true, hasPostStep: true }),
  processing(4, 'Post skipped'),
  main(4, 'postif', { type: 'node24', hasPostStep: true }),
  processing(4, 'Last step'),
  main(4, '__run_6'),
  processing(5, 'Post Post skipped'),
  skipping(5),
  processing(5, 'Post Run actions/checkout@v6'),
  telemetry(5, { action: 'actions/checkout', type: 'node24', stage: 'Post' }),
  processing(6, 'Post Remote with pre and post'),
  telemetry(6, { action: 'code-cargo/plan-prepost', type: 'node24', stage: 'Post' }),
  // This one is running: its telemetry comes when it finishes.
  processing(6, 'Post Start CargoWall'),
  `${at(6)} StepsRunner] Evaluating: always()`,
].join('\n')

describe('parseWorkerSteps context names', () => {
  it('names each step that ran by its runner context name, and leaves out the ones skipped', () => {
    const steps = parseWorkerSteps(JOB)
    expect(steps.map(s => [s.name, s.context_name])).toEqual([
      ['Pre Remote with pre and post', undefined],
      ['Run actions/checkout@v6', '__actions_checkout'],
      ['Start CargoWall', '__code-cargo_cargowall-action'],
      ['Named step', 'named'],
      ['Same name', '__run_3'],
      ['Same name', '__run_4'],
      ['Composite', 'composite'],
      ['Remote with pre and post', 'prepost'],
      ['Post skipped', 'postif'],
      ['Last step', '__run_6'],
      ['Post Run actions/checkout@v6', '__actions_checkout'],
      ['Post Remote with pre and post', 'prepost'],
      ['Post Start CargoWall', '__code-cargo_cargowall-action'],
    ])
  })

  it('chains completed_at past a skipped step to the next step that ran', () => {
    const steps = parseWorkerSteps(JOB)
    const named = steps.find(s => s.name === 'Named step')
    expect(named?.completed_at).toBe('2026-11-06T20:10:03Z')
    expect(steps.find(s => s.name === 'Skipped step')).toBeUndefined()
  })

  it('omits context_name where there is none, so older binaries see the same JSON', () => {
    const steps = parseWorkerSteps(JOB)
    expect(Object.keys(steps[0])).toEqual(['name', 'started_at', 'completed_at'])
    expect(JSON.stringify(steps[1])).toContain('"context_name":"__actions_checkout"')
  })

  it('gives post steps of same-named main steps their context names latest first', () => {
    const steps = parseWorkerSteps(
      [
        processing(1, 'Cache'),
        main(1, 'cache_a', { hasPostStep: true }),
        processing(2, 'Cache'),
        main(2, 'cache_b', { hasPostStep: true }),
        processing(3, 'Post Cache'),
        telemetry(3, { stage: 'Post' }),
        processing(4, 'Post Cache'),
        telemetry(4, { stage: 'Post' }),
      ].join('\n')
    )
    expect(steps.map(s => s.context_name)).toEqual(['cache_a', 'cache_b', 'cache_b', 'cache_a'])
  })

  it('names a post step only after a main step that has one', () => {
    const steps = parseWorkerSteps(
      [
        processing(1, 'Deploy'),
        main(1, 'deploy'),
        processing(2, 'Post Deploy'),
        telemetry(2, { stage: 'Post' }),
        processing(3, 'Post deploy notes'),
        main(3, 'notes'),
      ].join('\n')
    )
    expect(steps.map(s => [s.name, s.context_name])).toEqual([
      ['Deploy', 'deploy'],
      ['Post Deploy', undefined],
      ['Post deploy notes', 'notes'],
    ])
  })

  it('keeps a step whose telemetry does not parse, with no context name', () => {
    const steps = parseWorkerSteps(
      [
        processing(1, 'Build'),
        `${at(1)} ExecutionContext] Publish step telemetry for current step {`,
        '  "stage": "Main",',
        '  "stepContextName": "build",',
        processing(2, 'Test'),
        main(2, 'test'),
      ].join('\n')
    )
    expect(steps.map(s => [s.name, s.context_name])).toEqual([
      ['Build', undefined],
      ['Test', 'test'],
    ])
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

  it('accepts the Listener as well as the Worker', () => {
    expect(runnerRootFromExe('/opt/self-hosted/bin/Runner.Listener')).toBe('/opt/self-hosted')
  })

  it('strips the kernel\'s (deleted) suffix from a replaced binary', () => {
    expect(runnerRootFromExe('/home/runner/bin/Runner.Worker (deleted)')).toBe('/home/runner')
  })

  it('rejects an exe that is not a runner binary', () => {
    expect(runnerRootFromExe('/usr/bin/node')).toBeNull()
    expect(runnerRootFromExe('/bin/bash')).toBeNull()
  })

  it('rejects a runner-named binary outside a bin directory', () => {
    expect(runnerRootFromExe('/tmp/Runner.Worker')).toBeNull()
    expect(runnerRootFromExe('/home/runner/sbin/Runner.Worker')).toBeNull()
  })
})

describe('findRunnerRootFromAncestry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('walks past the shell and node to the worker on an ARC image', async () => {
    // The real chain in an ARC pod: the action's node under the step's bash
    // under the worker, whose exe is <root>/bin/Runner.Worker.
    withProc({
      500: { comm: 'node', ppid: 400, exe: '/usr/bin/node' },
      400: { comm: 'bash', ppid: 300, exe: '/bin/bash' },
      300: { comm: 'Runner.Worker', ppid: 200, exe: '/home/runner/bin/Runner.Worker' },
      200: { comm: 'Runner.Listener', ppid: 1, exe: '/home/runner/bin/Runner.Listener' },
    })
    await expect(findRunnerRootFromAncestry(500)).resolves.toBe('/home/runner')
  })

  it('resolves the versioned root on a hosted runner', async () => {
    withProc({
      90: { comm: 'node', ppid: 80, exe: '/usr/bin/node' },
      80: {
        comm: 'Runner.Worker',
        ppid: 1,
        exe: '/home/runner/actions-runner/cached/2.337.0/bin/Runner.Worker',
      },
    })
    await expect(findRunnerRootFromAncestry(90))
      .resolves.toBe('/home/runner/actions-runner/cached/2.337.0')
  })

  it('keeps walking past a worker whose exe is unreadable and matches the listener', async () => {
    // The worker's exe link is unreadable — it exited mid-walk, or is not
    // dumpable. Giving up there loses a root the listener still carries.
    withProc({
      500: { comm: 'node', ppid: 400, exe: '/usr/bin/node' },
      400: { comm: 'Runner.Worker', ppid: 300 },
      300: { comm: 'Runner.Listener', ppid: 1, exe: '/home/runner/bin/Runner.Listener' },
    })
    await expect(findRunnerRootFromAncestry(500)).resolves.toBe('/home/runner')
  })

  it('ignores a process merely named like the runner', async () => {
    // comm is a truncated label anyone can hold; only the exe path is a root.
    withProc({
      60: { comm: 'node', ppid: 50, exe: '/usr/bin/node' },
      50: { comm: 'Runner.Worker', ppid: 40, exe: '/tmp/evil/Runner.Worker' },
      40: { comm: 'Runner.Listener', ppid: 1, exe: '/home/runner/bin/Runner.Listener' },
    })
    await expect(findRunnerRootFromAncestry(60)).resolves.toBe('/home/runner')
  })

  it('returns null when the chain ends without a runner — a container job', async () => {
    withProc({
      30: { comm: 'node', ppid: 20, exe: '/usr/bin/node' },
      20: { comm: 'docker-init', ppid: 1, exe: '/sbin/docker-init' },
    })
    await expect(findRunnerRootFromAncestry(30)).resolves.toBeNull()
  })

  it('returns null without /proc at all instead of throwing', async () => {
    withProc({})
    await expect(findRunnerRootFromAncestry(1234)).resolves.toBeNull()
    await expect(findRunnerRootFromAncestry(1)).resolves.toBeNull()
  })
})

describe('findDiagDir', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  /** node under the worker, as every job runs it. */
  const chainTo = (exe: string): void => withProc({
    500: { comm: 'node', ppid: 400, exe: '/usr/bin/node' },
    400: { comm: 'Runner.Worker', ppid: 1, exe },
  })

  // A self-hosted root no hardcoded candidate can invent, so only the walk
  // can produce it — and /home/runner/_diag is laid down beside it, so a
  // findDiagDir that skips ancestry returns that instead and fails here.
  it('returns the _diag beside the runner root ancestry found', async () => {
    chainTo('/opt/actions-runner/bin/Runner.Worker')
    withPaths(['/opt/actions-runner/_diag', '/home/runner/_diag'])
    await expect(findDiagDir(500)).resolves.toBe('/opt/actions-runner/_diag')
  })

  it('falls through to the versioned layout when the derived _diag does not exist', async () => {
    chainTo('/opt/actions-runner/bin/Runner.Worker')
    withPaths(
      ['/home/runner/actions-runner/cached/2.337.0/_diag', '/home/runner/actions-runner/cached/_diag'],
      { '/home/runner/actions-runner/cached': ['2.337.0'] },
    )
    await expect(findDiagDir(500))
      .resolves.toBe('/home/runner/actions-runner/cached/2.337.0/_diag')
  })

  it('uses the known layouts when there is no runner ancestor', async () => {
    withProc({ 500: { comm: 'node', ppid: 1, exe: '/usr/bin/node' } })
    withPaths(['/home/runner/_diag'])
    await expect(findDiagDir(500)).resolves.toBe('/home/runner/_diag')
  })

  it('returns null when neither model finds anything', async () => {
    withProc({})
    withPaths([])
    await expect(findDiagDir(500)).resolves.toBeNull()
  })
})
