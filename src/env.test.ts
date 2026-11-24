import { describe, it, expect } from 'vitest'
import { ENV_CONFIG_VARS } from './configfile'
import { cargowallEnv, ignoredVarsWarning } from './env'

const SETTINGS = {
  configFile: null,
  allowedHosts: '',
  allowedCidrs: '',
  searchDomains: '',
  githubServiceHosts: 'github.com,api.github.com',
  azureInfraHosts: 'trafficmanager.net',
}

/**
 * Every variable the pinned cargowall (v2.0.0-rc.17) binds a setting to, or
 * reads directly, that the action does not set itself: none may arrive from
 * the job. The action-set ones are checked separately below.
 */
const JOB_SETTABLE = [
  'CARGOWALL_AUDIT_MODE',
  'CARGOWALL_API_URL',
  'CODECARGO_AUTH_TOKEN',
  'CARGOWALL_JOB_KEY',
  'CARGOWALL_API_FAILURE_MODE',
  'CARGOWALL_CONFIG',
  'CARGOWALL_BLOCKED_HOSTS',
  'CARGOWALL_BLOCKED_CIDRS',
  'CARGOWALL_SUDO_LOCKDOWN',
  'CARGOWALL_SUDO_ALLOW_COMMANDS',
  'CARGOWALL_SUDO_LOCKDOWN_USER',
  'CARGOWALL_TLS_SNI',
  'CARGOWALL_CONTAINER_EGRESS',
  'CARGOWALL_ALLOW_EXISTING_CONNECTIONS',
  'CARGOWALL_DOCKER_DNS_INTERCEPTION',
  'CARGOWALL_DNS_QUERY_FILTERING',
  'CARGOWALL_DNS_REDIRECT',
  'CARGOWALL_DNS_REDIRECT_IPTABLES',
  'CARGOWALL_DNS_UPSTREAM',
  'CARGOWALL_PREPOPULATE_DNS_CACHE',
  'CARGOWALL_AUTO_ALLOW_CLOUD_METADATA',
  'CARGOWALL_AUTO_ALLOW_GITHUB_HOSTS',
  'CARGOWALL_AUTO_ALLOW_GITLAB_HOSTS',
  'CARGOWALL_GITLAB_CI',
  'CARGOWALL_GITLAB_SERVICE_HOSTS',
  'CARGOWALL_CLOUD_PROVIDER',
  'CARGOWALL_GITHUB_ACTION',
  'CARGOWALL_STEP_ATTRIBUTION',
  'CARGOWALL_STEP_ORDINAL_BASE',
  'CARGOWALL_RUNNER_WORKER_PID',
  'CARGOWALL_INTERFACE',
  'CARGOWALL_BPF_STATS',
  'CARGOWALL_AUDIT_LOG',
  'CARGOWALL_PIDFILE',
  'CARGOWALL_READY_FILE',
  'CARGOWALL_FAILURE_FILE',
  'CARGOWALL_TEST_STRICT',
  'CARGOWALL_SCOPE_OUTSIDE',
  // Read by Go and its libraries, never by name in cargowall.
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'GODEBUG',
  'GOMAXPROCS',
  'GOTRACEBACK',
  'LD_PRELOAD',
]

/** The kept classes, each as the job might set it. */
const KEPT = {
  HTTPS_PROXY: 'http://proxy:3128',
  HTTP_PROXY: 'http://proxy:3128',
  NO_PROXY: 'localhost',
  https_proxy: 'http://proxy:3128',
  http_proxy: 'http://proxy:3128',
  no_proxy: 'localhost',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example:4318',
  OTEL_EXPORTER_OTLP_LOGS_HEADERS: 'authorization=Bearer x',
  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
  OTEL_RESOURCE_ATTRIBUTES: 'team=ci',
  OTEL_SERVICE_NAME: 'ci',
  ACTIONS_RUNTIME_URL: 'https://pipelines.actions.githubusercontent.com/x/',
  ACTIONS_RESULTS_URL: 'https://results-receiver.actions.githubusercontent.com/',
  ACTIONS_CACHE_URL: 'https://artifactcache.actions.githubusercontent.com/x/',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/x/idtoken',
  DOCKER_HOST: 'tcp://localhost:2375',
  DOCKER_CONTEXT: 'dind',
  DOCKER_CONFIG: '/home/runner/.docker',
  HOME: '/home/runner',
  PATH: '/usr/local/bin:/usr/bin:/bin',
}

function jobEnv(): NodeJS.ProcessEnv {
  return {
    ...KEPT,
    ...Object.fromEntries(JOB_SETTABLE.map(n => [n, `job-${n}`])),
    ...Object.fromEntries(ENV_CONFIG_VARS.map(n => [n, `job-${n}`])),
    CARGOWALL_GITHUB_SERVICE_HOSTS: 'job-hosts',
    CARGOWALL_AZURE_INFRA_HOSTS: 'job-hosts',
    GITHUB_TOKEN: 'ghs_secret',
    ACTIONS_RUNTIME_TOKEN: 'secret',
    RUNNER_TEMP: '/home/runner/work/_temp',
  }
}

describe('cargowallEnv', () => {
  it('passes no variable the job set that cargowall would read as a setting', () => {
    const { env } = cargowallEnv(jobEnv(), SETTINGS)
    for (const name of JOB_SETTABLE) expect(env[name], name).toBeUndefined()
    for (const name of ['GITHUB_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'RUNNER_TEMP']) expect(env[name], name).toBeUndefined()
  })

  it('keeps the proxy, OTLP, runner-endpoint, Docker and PATH variables, lower-case proxies included', () => {
    const { env } = cargowallEnv(jobEnv(), SETTINGS)
    expect(env).toMatchObject(KEPT)
  })

  it("is the action's settings and the kept classes, nothing else", () => {
    const { env } = cargowallEnv(jobEnv(), SETTINGS)
    expect(Object.keys(env).sort()).toEqual(
      [
        ...Object.keys(KEPT),
        'CARGOWALL_GITHUB_SERVICE_HOSTS',
        'CARGOWALL_AZURE_INFRA_HOSTS',
        'CARGOWALL_DEFAULT_ACTION',
      ].sort()
    )
    const configNames = Object.keys(env).filter(n => /^(CARGOWALL|CODECARGO)_/.test(n))
    expect(configNames.sort()).toEqual(['CARGOWALL_AZURE_INFRA_HOSTS', 'CARGOWALL_DEFAULT_ACTION', 'CARGOWALL_GITHUB_SERVICE_HOSTS'])
  })

  it("sets the host lists from the step, over the job's", () => {
    const { env } = cargowallEnv(jobEnv(), SETTINGS)
    expect(env.CARGOWALL_GITHUB_SERVICE_HOSTS).toBe('github.com,api.github.com')
    expect(env.CARGOWALL_AZURE_INFRA_HOSTS).toBe('trafficmanager.net')
  })

  it("without a config file, sets deny and the inputs, never the job's", () => {
    const { env } = cargowallEnv(jobEnv(), {
      ...SETTINGS,
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
    expect(env.CARGOWALL_BLOCKED_HOSTS).toBeUndefined()
    expect(env.CARGOWALL_BLOCKED_CIDRS).toBeUndefined()
  })

  it("without a config file and an empty input, leaves that variable unset rather than the job's", () => {
    const { env } = cargowallEnv(jobEnv(), SETTINGS)
    expect(env.CARGOWALL_ALLOWED_HOSTS).toBeUndefined()
    expect(env.CARGOWALL_SEARCH_DOMAINS).toBeUndefined()
  })

  it('with a config file, passes none of the LoadFromEnv variables, so cargowall reads the file', () => {
    const { env } = cargowallEnv(jobEnv(), { ...SETTINGS, configFile: '/work/cargowall.json' })
    for (const name of ENV_CONFIG_VARS) expect(env[name], name).toBeUndefined()
    expect(env.PATH).toBe(KEPT.PATH)
  })

  it("names every CARGOWALL_ and CODECARGO_ variable the job carried, the action's own included", () => {
    const { ignored } = cargowallEnv(jobEnv(), SETTINGS)
    const expected = [...new Set([...JOB_SETTABLE, ...ENV_CONFIG_VARS, 'CARGOWALL_GITHUB_SERVICE_HOSTS', 'CARGOWALL_AZURE_INFRA_HOSTS'])]
      .filter(n => /^(CARGOWALL|CODECARGO)_/.test(n))
      .sort()
    expect(ignored).toEqual(expected)
    expect(cargowallEnv({ PATH: '/usr/bin', CARGOWALL: 'x', XCARGOWALL_Y: 'x' }, SETTINGS).ignored).toEqual([])
  })
})

// cargowall refuses to start with a file CARGOWALL_CONFIG names beside the
// environment configuration, which the inputs always set without a config
// file: a runner that carries the variable would fail every job.
describe('CARGOWALL_CONFIG', () => {
  it("never lets the job's CARGOWALL_CONFIG through, with a config file or without", () => {
    const base = { CARGOWALL_CONFIG: '/etc/cargowall/runner.json', PATH: '/usr/bin' }
    for (const configFile of [null, '/work/cargowall.json']) {
      const { env, ignored } = cargowallEnv(base, { ...SETTINGS, configFile })
      expect(env.CARGOWALL_CONFIG, String(configFile)).toBeUndefined()
      expect(env.PATH).toBe('/usr/bin')
      expect(ignored).toEqual(['CARGOWALL_CONFIG'])
    }
    expect(base.CARGOWALL_CONFIG).toBe('/etc/cargowall/runner.json')
  })
})

describe('ignoredVarsWarning', () => {
  it('is one line naming the variables and never their values', () => {
    const job = { CARGOWALL_AUDIT_MODE: 'true', CODECARGO_AUTH_TOKEN: 'secret-token-value', PATH: '/usr/bin' }
    const warning = ignoredVarsWarning(cargowallEnv(job, SETTINGS).ignored)
    expect(warning).toContain('CARGOWALL_AUDIT_MODE')
    expect(warning).toContain('CODECARGO_AUTH_TOKEN')
    expect(warning).not.toContain('secret-token-value')
    expect(warning).not.toContain('true')
    expect(warning).not.toContain('\n')
  })

  it('says nothing when the job carried none', () => {
    expect(ignoredVarsWarning([])).toBeNull()
  })
})
