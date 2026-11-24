import { describe, it, expect } from 'vitest'
import { ENV_CONFIG_VARS } from './configfile'

describe('ENV_CONFIG_VARS', () => {
  it("names every variable cargowall's LoadFromEnv reads as a configuration", () => {
    // Any one of these set makes cargowall load the environment and skip
    // --config: a name missing here would leave the file unread.
    expect([...ENV_CONFIG_VARS].sort()).toEqual([
      'CARGOWALL_ALLOWED_CIDRS',
      'CARGOWALL_ALLOWED_HOSTS',
      'CARGOWALL_BLOCKED_CIDRS',
      'CARGOWALL_BLOCKED_HOSTS',
      'CARGOWALL_DEFAULT_ACTION',
      'CARGOWALL_SEARCH_DOMAINS',
    ])
  })
})
