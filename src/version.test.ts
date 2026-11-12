import { describe, it, expect } from 'vitest'
import { ACTION_VERSION, actionVersionLine } from './version'

const REPO = 'code-cargo/cargowall-action'

describe('actionVersionLine', () => {
  it('names the version and the tag the job used', () => {
    expect(actionVersionLine('v1.3.10', { GITHUB_ACTION_REPOSITORY: REPO, GITHUB_ACTION_REF: 'v1.3.10' })).toBe(
      'cargowall-action: v1.3.10 (code-cargo/cargowall-action@v1.3.10)'
    )
  })

  it('names the SHA a job pinned', () => {
    const sha = '6edf046a8c1c6bcac21f8409c42f094418449839'
    expect(actionVersionLine('v1.3.10', { GITHUB_ACTION_REPOSITORY: REPO, GITHUB_ACTION_REF: sha })).toBe(
      `cargowall-action: v1.3.10 (${REPO}@${sha})`
    )
  })

  it('leaves out an empty ref, with no bare @', () => {
    expect(actionVersionLine('v1.3.10', { GITHUB_ACTION_REPOSITORY: REPO, GITHUB_ACTION_REF: '' })).toBe(
      `cargowall-action: v1.3.10 (${REPO})`
    )
    expect(actionVersionLine('v1.3.10', {})).toBe('cargowall-action: v1.3.10 (local)')
  })

  it('leaves out an empty version', () => {
    expect(actionVersionLine('', { GITHUB_ACTION_REPOSITORY: REPO, GITHUB_ACTION_REF: 'abc123' })).toBe(
      `cargowall-action: ${REPO}@abc123`
    )
    expect(actionVersionLine('', {})).toBe('cargowall-action: local')
  })

  it("defaults to this branch's version: a release's, with no -rc suffix, or none", () => {
    expect(ACTION_VERSION).toMatch(/^(v\d+\.\d+\.\d+)?$/)
    expect(actionVersionLine(undefined, {})).toBe(actionVersionLine(ACTION_VERSION, {}))
  })
})
