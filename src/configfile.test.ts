import { describe, it, expect } from 'vitest'
import { ENV_CONFIG_VARS, localConfigEnv } from './configfile'

const NONE = { allowedHosts: '', allowedCidrs: '', searchDomains: '' }

describe('localConfigEnv', () => {
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

  it('with a config file, lets none of them through, the job environment included', () => {
    const base = Object.fromEntries([...ENV_CONFIG_VARS.map(n => [n, 'x']), ['PATH', '/usr/bin'], ['CARGOWALL_API_URL', 'kept']])
    const env = localConfigEnv(base, '/work/cargowall.json', NONE)
    for (const name of ENV_CONFIG_VARS) expect(env[name], name).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
    expect(env.CARGOWALL_API_URL).toBe('kept')
  })

  it('without one, sets deny and the inputs, over what the job set', () => {
    const env = localConfigEnv({ CARGOWALL_DEFAULT_ACTION: 'allow' }, null, {
      allowedHosts: 'github.com',
      allowedCidrs: '10.0.0.0/8',
      searchDomains: '.internal',
    })
    expect(env).toMatchObject({
      CARGOWALL_DEFAULT_ACTION: 'deny',
      CARGOWALL_ALLOWED_HOSTS: 'github.com',
      CARGOWALL_ALLOWED_CIDRS: '10.0.0.0/8',
      CARGOWALL_SEARCH_DOMAINS: '.internal',
    })
  })
})
