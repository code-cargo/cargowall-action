import { describe, it, expect } from 'vitest'
import { shouldRunSummary } from './summary'

/**
 * The summary invocation is also the SaaS push, so a missing audit log must not
 * short-circuit it — that early return is what made cargowall's zero-event push
 * unreachable from the action (#71).
 */
describe('shouldRunSummary', () => {
  it('runs when there are events to render', () => {
    expect(shouldRunSummary({ haveEvents: true, canPush: false })).toBe(true)
  })

  it('runs with no events at all when the API is configured', () => {
    // The zero-event push still carries the job record, effective mode, status,
    // cargowall version and any downgrade record.
    expect(shouldRunSummary({ haveEvents: false, canPush: true })).toBe(true)
  })

  it('runs when both apply', () => {
    expect(shouldRunSummary({ haveEvents: true, canPush: true })).toBe(true)
  })

  it('skips only when there is nothing to render and nothing to push', () => {
    expect(shouldRunSummary({ haveEvents: false, canPush: false })).toBe(false)
  })
})
