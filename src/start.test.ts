import { describe, it, expect, vi, beforeEach } from 'vitest'
import { requireNonEmptyHostList } from './start'

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
