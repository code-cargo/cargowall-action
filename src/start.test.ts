import { describe, it, expect, vi, beforeEach } from 'vitest'
import { requireNonEmptyHostList, resolveApiFailureMode } from './start'

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
