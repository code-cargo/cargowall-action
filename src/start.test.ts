import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  requireNonEmptyHostList,
  resolveApiFailureMode,
  isLockdownRecord,
  downgradeMessage,
} from './start'

// Mock @actions/core — requireNonEmptyHostList calls core.getMultilineInput
vi.mock('@actions/core', () => ({
  getMultilineInput: vi.fn(),
}))

import * as core from '@actions/core'

/**
 * getMultilineInput drops empty lines, so an input explicitly set to '' arrives
 * here as []. Absent inputs never look like this: both host-list inputs carry a
 * non-empty default in action.yml, which the runner materializes for us.
 */
function withInput(lines: string[]): void {
  vi.mocked(core.getMultilineInput).mockReturnValue(lines)
}

describe('requireNonEmptyHostList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the action.yml default when the input is not overridden', () => {
    withInput(['github.com', 'api.github.com', 'actions.githubusercontent.com'])
    expect(requireNonEmptyHostList('github-service-hosts')).toBe(
      'github.com,api.github.com,actions.githubusercontent.com'
    )
  })

  it('returns a caller-supplied list', () => {
    withInput(['github.com', 'internal.example.com'])
    expect(requireNonEmptyHostList('github-service-hosts')).toBe('github.com,internal.example.com')
  })

  it('splits comma-separated entries too', () => {
    withInput(['github.com, api.github.com'])
    expect(requireNonEmptyHostList('github-service-hosts')).toBe('github.com,api.github.com')
  })

  it('throws when the input is explicitly emptied', () => {
    withInput([])
    expect(() => requireNonEmptyHostList('github-service-hosts')).toThrow(
      /"github-service-hosts" was set to an empty value/
    )
  })

  it('throws when the input is only whitespace and separators', () => {
    withInput(['  ', ','])
    expect(() => requireNonEmptyHostList('azure-infra-hosts')).toThrow(
      /"azure-infra-hosts" was set to an empty value/
    )
  })

  it('explains that emptying does not disable the auto-allow', () => {
    withInput([])
    expect(() => requireNonEmptyHostList('azure-infra-hosts')).toThrow(
      /does not disable the auto-allowed hosts/
    )
  })
})

describe('resolveApiFailureMode', () => {
  it('defaults to audit so a policy outage cannot silently keep enforcing local config', () => {
    expect(resolveApiFailureMode({ input: '', modeSupplied: false }).value).toBe('audit')
  })

  it('defers to an explicitly set mode rather than downgrading it', () => {
    const r = resolveApiFailureMode({ input: '', modeSupplied: true })
    expect(r.value).toBe('local')
    expect(r.reason).toMatch(/explicitly set `mode`/)
  })

  it('lets an explicit api-failure-mode win over an explicit mode', () => {
    // Both are explicit, but only api-failure-mode is *about* fetch failures.
    expect(resolveApiFailureMode({ input: 'audit', modeSupplied: true }).value).toBe('audit')
    expect(resolveApiFailureMode({ input: 'fail', modeSupplied: true }).value).toBe('fail')
  })

  it('translates the public "enforce" spelling to cargowall\'s "local"', () => {
    expect(resolveApiFailureMode({ input: 'enforce', modeSupplied: false }).value).toBe('local')
  })

  it('accepts "local" as an alias so either vocabulary works', () => {
    expect(resolveApiFailureMode({ input: 'local', modeSupplied: false }).value).toBe('local')
  })

  it('passes fail through', () => {
    expect(resolveApiFailureMode({ input: 'fail', modeSupplied: false }).value).toBe('fail')
  })

  it('is case- and whitespace-insensitive', () => {
    expect(resolveApiFailureMode({ input: '  Fail \n', modeSupplied: false }).value).toBe('fail')
  })

  it('throws on an unrecognised value rather than guessing a posture', () => {
    expect(() => resolveApiFailureMode({ input: 'abort', modeSupplied: false })).toThrow(
      /Invalid "api-failure-mode" value "abort"/
    )
  })
})

/**
 * The failure sentinel is written for BOTH policy lockdown and any fatal
 * startup error. Misreading a generic crash as lockdown would fail builds that
 * `fail-on-unsupported: false` (the default) says to warn-and-continue on, so
 * everything unrecognised must read as "not lockdown".
 */
describe('isLockdownRecord', () => {
  it('recognises a lockdown downgrade record', () => {
    expect(isLockdownRecord(JSON.stringify({ type: 'CARGO_WALL_DOWNGRADE_TYPE_LOCKDOWN' }))).toBe(true)
  })

  it('does not treat an audit fallback as lockdown', () => {
    expect(
      isLockdownRecord(JSON.stringify({ type: 'CARGO_WALL_DOWNGRADE_TYPE_AUDIT_FALLBACK' }))
    ).toBe(false)
  })

  it('treats an absent record as not lockdown — the generic startup-failure path', () => {
    expect(isLockdownRecord(null)).toBe(false)
  })

  it('treats unparseable JSON as not lockdown rather than failing the build', () => {
    expect(isLockdownRecord('{"type": ')).toBe(false)
  })

  it('treats a record with no type as not lockdown', () => {
    expect(isLockdownRecord(JSON.stringify({ detail: 'something happened' }))).toBe(false)
  })
})

describe('downgradeMessage', () => {
  it('returns null when no posture change was recorded', () => {
    expect(downgradeMessage(null)).toBeNull()
  })

  it('surfaces the human-readable detail', () => {
    const raw = JSON.stringify({
      type: 'CARGO_WALL_DOWNGRADE_TYPE_AUDIT_FALLBACK',
      detail: 'downgraded to audit mode: policy could not be retrieved',
    })
    expect(downgradeMessage(raw)).toBe(
      'CargoWall changed enforcement posture: downgraded to audit mode: policy could not be retrieved'
    )
  })

  it('still warns when the record is unparseable — losing the notice is worse than raw JSON', () => {
    expect(downgradeMessage('{"type":')).toMatch(/changed enforcement posture during startup/)
  })

  it('still warns when the record parses but carries no detail', () => {
    expect(downgradeMessage(JSON.stringify({ type: 'CARGO_WALL_DOWNGRADE_TYPE_LOCKDOWN' }))).toMatch(
      /changed enforcement posture during startup/
    )
  })

  it('returns null for an empty record rather than warning about nothing', () => {
    expect(downgradeMessage('   ')).toBeNull()
  })
})
