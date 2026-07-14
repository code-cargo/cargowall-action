import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@actions/core', () => ({
  setOutput: vi.fn(),
  saveState: vi.fn(),
  setFailed: vi.fn(),
}))
vi.mock('./setup', () => ({ setup: vi.fn() }))
vi.mock('./start', () => ({ start: vi.fn() }))

import * as core from '@actions/core'
import { setup } from './setup'
import { start } from './start'

/**
 * main.ts invokes run() on import, so re-import it fresh to drive each path.
 *
 * resetModules() clears the *module* registry but not the *mock* registry, so the
 * re-imported main.ts binds to the very same vi.fn() instances stubbed above — no
 * need to re-import the mocks after the reset. The `start` assertions below would
 * fail if that were not true.
 */
async function runMain(): Promise<void> {
  vi.resetModules()
  await import('./main')
  // run() is async and not awaited by the module body; let its microtasks settle.
  await vi.waitFor(() => {
    expect(vi.mocked(setup)).toHaveBeenCalled()
  })
}

describe('main', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reports supported=false and skips start when eBPF is unsupported', async () => {
    vi.mocked(setup).mockResolvedValue(false)

    await runMain()

    // Without this, `supported` is the empty string on exactly the runner where a
    // workflow would branch on it — see the else-branch of `steps.<id>.outputs.supported`.
    expect(core.setOutput).toHaveBeenCalledWith('supported', 'false')
    expect(core.saveState).toHaveBeenCalledWith('cargowall-skipped', 'true')
    expect(start).not.toHaveBeenCalled()
  })

  it('starts cargowall when eBPF is supported', async () => {
    vi.mocked(setup).mockResolvedValue(true)
    vi.mocked(start).mockResolvedValue({ supported: true, pid: 123 })

    await runMain()
    await vi.waitFor(() => expect(start).toHaveBeenCalled())

    // start() owns the success outputs; main must not pre-empt them with 'false'.
    expect(core.setOutput).not.toHaveBeenCalledWith('supported', 'false')
    expect(core.saveState).not.toHaveBeenCalledWith('cargowall-skipped', 'true')
  })

  it('fails the step when setup throws', async () => {
    vi.mocked(setup).mockRejectedValue(new Error('kernel too old'))

    await runMain()

    await vi.waitFor(() => {
      expect(core.setFailed).toHaveBeenCalledWith('kernel too old')
    })
  })
})
