import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * #71: `audit-summary` must gate *rendering only*. `cargowall summary` is also
 * the SaaS push, so skipping the invocation made those jobs invisible to the
 * dashboard — no job record, no effective mode, no downgrade record.
 */

vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  getState: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}))
vi.mock('./cleanup', () => ({ cleanup: vi.fn() }))
vi.mock('./summary', () => ({ generateSummary: vi.fn() }))

import * as core from '@actions/core'
import { cleanup } from './cleanup'
import { generateSummary } from './summary'

/** post.ts invokes run() on import, so re-import it fresh to drive each path. */
async function runPost(): Promise<void> {
  vi.resetModules()
  await import('./post')
  await vi.waitFor(() => {
    expect(vi.mocked(cleanup)).toHaveBeenCalled()
  })
}

function withInputs(inputs: Record<string, string>): void {
  vi.mocked(core.getInput).mockImplementation((name: string) => inputs[name] ?? '')
}

describe('post', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // cargowall started, so the post step does its full job.
    vi.mocked(core.getState).mockImplementation((name: string) =>
      name === 'cargowall-pid' ? '4242' : ''
    )
    withInputs({})
  })

  it('renders and pushes by default', async () => {
    withInputs({ 'api-url': 'https://app.codecargo.com' })
    await runPost()
    expect(generateSummary).toHaveBeenCalledWith({ render: true })
  })

  it('still runs the summary with audit-summary:false when the API is configured', async () => {
    withInputs({ 'audit-summary': 'false', 'api-url': 'https://app.codecargo.com' })

    await runPost()

    // The push lives inside this invocation — skipping it is the #71 bug.
    expect(generateSummary).toHaveBeenCalledWith({ render: false })
  })

  it('renders when audit-summary is on even with no API configured', async () => {
    withInputs({ 'api-url': '' })
    await runPost()
    expect(generateSummary).toHaveBeenCalledWith({ render: true })
  })

  it('skips entirely when there is nothing to render and nothing to push', async () => {
    withInputs({ 'audit-summary': 'false', 'api-url': '' })
    await runPost()
    expect(generateSummary).not.toHaveBeenCalled()
  })

  it('treats offline as nothing to push, so audit-summary:false skips entirely', async () => {
    withInputs({
      'audit-summary': 'false',
      'api-url': 'https://app.codecargo.com',
      offline: 'true',
    })

    await runPost()

    expect(generateSummary).not.toHaveBeenCalled()
  })

  it('still pushes when offline is set to anything other than the literal "true"', async () => {
    withInputs({
      'audit-summary': 'false',
      'api-url': 'https://app.codecargo.com',
      offline: 'false',
    })

    await runPost()

    expect(generateSummary).toHaveBeenCalledWith({ render: false })
  })

  it('does nothing when cargowall was never started', async () => {
    vi.mocked(core.getState).mockImplementation((name: string) =>
      name === 'cargowall-skipped' ? 'true' : ''
    )
    withInputs({ 'api-url': 'https://app.codecargo.com' })

    vi.resetModules()
    await import('./post')
    await vi.waitFor(() => expect(core.info).toHaveBeenCalled())

    expect(generateSummary).not.toHaveBeenCalled()
    expect(cleanup).not.toHaveBeenCalled()
  })
})
