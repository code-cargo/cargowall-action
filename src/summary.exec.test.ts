import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Covers generateSummary's three-way outcome split around the actual
 * `cargowall summary` invocation:
 *
 *   exit 0, rendering off        → done; nothing written, no fallback
 *   exit 0, markdown produced    → written to the workflow summary
 *   exit != 0, or exit 0 with
 *   EMPTY stdout while rendering → warn + basic `--steps []` fallback
 *
 * The empty-stdout-on-success case is the regression surface: it is reachable
 * via the zero-event push shape and was once mislabelled "rendering disabled"
 * while silently dropping the fallback.
 *
 * Lives in its own file because it mocks the whole module graph, while
 * summary.test.ts keeps its mocks minimal for the pure helpers.
 */

vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  getState: vi.fn(() => ''),
  getIDToken: vi.fn(async () => 'oidc-token'),
  startGroup: vi.fn(),
  endGroup: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  summary: {
    addRaw: vi.fn().mockReturnThis(),
    write: vi.fn(async () => undefined),
  },
}))
vi.mock('@actions/exec', () => ({ exec: vi.fn(async () => 0) }))
vi.mock('@actions/github', () => ({
  context: { job: 'build', runId: 0, repo: { owner: 'o', repo: 'r' } },
  getOctokit: vi.fn(),
}))
vi.mock('./diag', () => ({
  findDiagDir: vi.fn(async () => null),
  parseExecutedSteps: vi.fn(async () => []),
  scanBlocks: vi.fn(async () => []),
}))
vi.mock('fs', () => ({
  promises: {
    stat: vi.fn(async () => ({ size: 1024 })),
    readFile: vi.fn(async () => { throw new Error('ENOENT') }),
  },
}))

import * as core from '@actions/core'
import * as exec from '@actions/exec'
import { promises as fsp } from 'fs'
import { generateSummary } from './summary'

/** Inputs not named fall back to '' — token stays empty so the API path skips. */
function withInputs(inputs: Record<string, string>): void {
  vi.mocked(core.getInput).mockImplementation((name: string) => inputs[name] ?? '')
}

/**
 * Script the `cargowall summary` invocations: each entry is one exec call's
 * (exit code, stdout). Feeds stdout through the listener like the real exec.
 */
function scriptExec(runs: Array<{ code: number; stdout: string }>): void {
  let call = 0
  vi.mocked(exec.exec).mockImplementation(async (_cmd, _args, options) => {
    const run = runs[Math.min(call++, runs.length - 1)]
    if (run.stdout) options?.listeners?.stdout?.(Buffer.from(run.stdout))
    return run.code
  })
}

/** The argv of the nth cargowall invocation. */
function execArgs(n: number): string[] {
  return vi.mocked(exec.exec).mock.calls[n]?.[1] as string[]
}

describe('generateSummary outcome split', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(core.getState).mockReturnValue('')
    vi.mocked(fsp.stat).mockResolvedValue({ size: 1024 } as Awaited<ReturnType<typeof fsp.stat>>)
    vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'))
    withInputs({})
  })

  it('render on, exit 0 with markdown → writes the workflow summary', async () => {
    scriptExec([{ code: 0, stdout: '## CargoWall Audit Summary\n' }])

    await generateSummary({ render: true })

    expect(core.summary.addRaw).toHaveBeenCalledWith('## CargoWall Audit Summary\n')
    expect(core.warning).not.toHaveBeenCalled()
    // No fallback invocation.
    expect(vi.mocked(exec.exec).mock.calls.filter(c => c[0] === 'cargowall')).toHaveLength(1)
  })

  it('render off with API configured → invocation still runs, nothing rendered', async () => {
    withInputs({ 'api-url': 'https://app.codecargo.com' })
    scriptExec([{ code: 0, stdout: '' }])

    await generateSummary({ render: false })

    // The push lives inside this invocation — it must carry the API flags.
    expect(execArgs(0)).toContain('--api-url')
    expect(core.summary.addRaw).not.toHaveBeenCalled()
    expect(core.info).toHaveBeenCalledWith('Audit summary complete (rendering disabled)')
    // Rendering-only fallback must not run either.
    expect(vi.mocked(exec.exec).mock.calls.filter(c => c[0] === 'cargowall')).toHaveLength(1)
  })

  it('render on, exit 0 with EMPTY stdout → warns and runs the basic fallback', async () => {
    // The zero-event push shape: success, but no markdown to render. Must not
    // be mislabelled "rendering disabled".
    scriptExec([
      { code: 0, stdout: '' },
      { code: 0, stdout: '## Basic Summary\n' },
    ])

    await generateSummary({ render: true })

    expect(core.info).not.toHaveBeenCalledWith('Audit summary complete (rendering disabled)')
    expect(core.warning).toHaveBeenCalledWith('Failed to generate audit summary with step correlation')
    expect(execArgs(1)).toEqual(['summary', '--audit-log', '/tmp/cargowall-audit.json', '--steps', '[]'])
    expect(core.summary.addRaw).toHaveBeenCalledWith('## Basic Summary\n')
  })

  it('render on, non-zero exit → warns and runs the basic fallback', async () => {
    scriptExec([
      { code: 1, stdout: '' },
      { code: 0, stdout: '## Basic Summary\n' },
    ])

    await generateSummary({ render: true })

    expect(core.warning).toHaveBeenCalledWith('Failed to generate audit summary with step correlation')
    expect(execArgs(1)).toEqual(['summary', '--audit-log', '/tmp/cargowall-audit.json', '--steps', '[]'])
    expect(core.summary.addRaw).toHaveBeenCalledWith('## Basic Summary\n')
  })

  it('render off, non-zero exit → warns but skips the rendering-only fallback', async () => {
    withInputs({ 'api-url': 'https://app.codecargo.com' })
    scriptExec([{ code: 1, stdout: '' }])

    await generateSummary({ render: false })

    expect(core.warning).toHaveBeenCalledWith('Failed to generate audit summary with step correlation')
    expect(vi.mocked(exec.exec).mock.calls.filter(c => c[0] === 'cargowall')).toHaveLength(1)
  })

  it('missing audit log with API configured → still invokes for the zero-event push', async () => {
    withInputs({ 'api-url': 'https://app.codecargo.com' })
    vi.mocked(fsp.stat).mockRejectedValue(new Error('ENOENT'))
    scriptExec([{ code: 0, stdout: '' }])

    await generateSummary({ render: false })

    expect(vi.mocked(exec.exec).mock.calls.filter(c => c[0] === 'cargowall')).toHaveLength(1)
    expect(execArgs(0)).toContain('--api-url')
  })

  it('missing audit log and nothing to push → skips the invocation entirely', async () => {
    vi.mocked(fsp.stat).mockRejectedValue(new Error('ENOENT'))

    await generateSummary({ render: true })

    expect(exec.exec).not.toHaveBeenCalled()
  })
})
