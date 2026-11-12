import { describe, it, expect } from 'vitest'
import { ACTION_VERSION, actionVersionLine, sourceFromPath } from './version'

const REPO = 'code-cargo/cargowall-action'
const SHA = '6edf046a8c1c6bcac21f8409c42f094418449839'
const LOCAL = '/home/runner/work/app/app/dist/main'
const env = (ref: string) => ({ GITHUB_ACTION_REPOSITORY: REPO, GITHUB_ACTION_REF: ref })

describe('actionVersionLine', () => {
  it("names the release exactly at its own tag, an rc's, and its major tag", () => {
    expect(actionVersionLine('v1.3.10', env('v1.3.10'), LOCAL)).toBe(`cargowall-action: v1.3.10 (${REPO}@v1.3.10)`)
    expect(actionVersionLine('v1.3.10', env('v1.3.10-rc.2'), LOCAL)).toBe(`cargowall-action: v1.3.10-rc.2 (${REPO}@v1.3.10-rc.2)`)
    expect(actionVersionLine('v1.3.10', env('v1'), LOCAL)).toBe(`cargowall-action: v1.3.10 (${REPO}@v1)`)
  })

  it('says "or a later commit" for a SHA, a branch, another tag, or no ref', () => {
    for (const ref of [SHA, 'release/v1', 'v1.3.9', 'v1.3.100', 'v1.3.10-rc.2x']) {
      expect(actionVersionLine('v1.3.10', env(ref), LOCAL), ref).toBe(`cargowall-action: v1.3.10 or a later commit (${REPO}@${ref})`)
    }
    expect(actionVersionLine('v1.3.10', env(''), LOCAL)).toBe(`cargowall-action: v1.3.10 or a later commit (${REPO})`)
  })

  it('reads the source from the action path when the runner reports none', () => {
    const dir = `/home/runner/work/_actions/code-cargo/cargowall-action/v1.3.10/dist/main`
    expect(actionVersionLine('v1.3.10', {}, dir)).toBe(`cargowall-action: v1.3.10 (${REPO}@v1.3.10)`)
    expect(actionVersionLine('v1.3.10', {}, LOCAL)).toBe(
      'cargowall-action: v1.3.10 or a later commit (source not reported by the runner)'
    )
  })

  it('leaves out an empty version', () => {
    expect(actionVersionLine('', env(SHA), LOCAL)).toBe(`cargowall-action: ${REPO}@${SHA}`)
    expect(actionVersionLine('', {}, LOCAL)).toBe('cargowall-action: source not reported by the runner')
  })

  it("defaults to this branch's version: a release's, with no -rc suffix, or none", () => {
    expect(ACTION_VERSION).toMatch(/^(v\d+\.\d+\.\d+)?$/)
    expect(actionVersionLine(undefined, {}, LOCAL)).toBe(actionVersionLine(ACTION_VERSION, {}, LOCAL))
  })
})

describe('sourceFromPath', () => {
  it("reads owner, repo and ref from a downloaded action's path", () => {
    expect(sourceFromPath('/home/runner/work/_actions/code-cargo/cargowall-action/6edf046/dist/main')).toEqual({
      repo: REPO,
      ref: '6edf046'
    })
    expect(sourceFromPath('/_actions/o/r/v1')).toEqual({ repo: 'o/r', ref: 'v1' })
  })

  it('finds none in any other path', () => {
    expect(sourceFromPath(LOCAL)).toBeNull()
    expect(sourceFromPath('/home/runner/work/_actions/o/r')).toBeNull()
  })
})
