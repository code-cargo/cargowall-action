import { describe, it, expect } from 'vitest'
import {
  CARGOWALL_PATH,
  CARGOWALL_READS,
  LOCAL_CONFIG_VARS,
  cargowallEnv,
  envWarnings,
  ignoredVarsWarning,
  trustStoreWarning,
} from './env'


const SETTINGS = {
  configFile: null,
  allowedHosts: '',
  allowedCidrs: '',
  searchDomains: '',
  githubServiceHosts: 'github.com,api.github.com',
  azureInfraHosts: 'trafficmanager.net',
}

/**
 * Variables Go and its libraries read, never by name in cargowall: none may
 * arrive from the job either.
 */
const RUNTIME_VARS = ['SSL_CERT_FILE', 'SSL_CERT_DIR', 'GODEBUG', 'GOMAXPROCS', 'GOTRACEBACK', 'LD_PRELOAD']

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
  DOCKER_HOST: 'tcp://localhost:2376',
  DOCKER_CONTEXT: 'dind',
  DOCKER_CONFIG: '/home/runner/.docker',
  DOCKER_TLS: '1',
  DOCKER_TLS_VERIFY: '1',
  DOCKER_CERT_PATH: '/certs/client',
  DOCKER_API_VERSION: '1.47',
  HOME: '/home/runner',
}

function jobEnv(): NodeJS.ProcessEnv {
  return {
    ...KEPT,
    PATH: '/home/runner/.local/bin:/usr/bin:/bin',
    ...Object.fromEntries([...CARGOWALL_READS, ...RUNTIME_VARS].map(n => [n, `job-${n}`])),
    CARGOWALL_VERSION: 'v2.0.0-rc.17',
    CODECARGO_OTHER_TOOL: 'x',
    GITHUB_TOKEN: 'ghs_secret',
    ACTIONS_RUNTIME_TOKEN: 'secret',
    RUNNER_TEMP: '/home/runner/work/_temp',
  }
}

describe('cargowallEnv', () => {
  it('passes no variable the job set that cargowall would read as a setting', () => {
    const { env } = cargowallEnv(jobEnv(), SETTINGS)
    const passed = [...CARGOWALL_READS, ...RUNTIME_VARS].filter(
      n => !['CARGOWALL_GITHUB_SERVICE_HOSTS', 'CARGOWALL_AZURE_INFRA_HOSTS', 'CARGOWALL_DEFAULT_ACTION'].includes(n)
    )
    for (const name of passed) expect(env[name], name).toBeUndefined()
    expect(env.CARGOWALL_GITHUB_SERVICE_HOSTS).not.toMatch(/^job-/)
    expect(env.CARGOWALL_DEFAULT_ACTION).toBe('deny')
    for (const name of ['GITHUB_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'RUNNER_TEMP']) expect(env[name], name).toBeUndefined()
  })

  it('keeps the proxy, OTLP, runner-endpoint and Docker variables, lower-case proxies included', () => {
    const { env } = cargowallEnv(jobEnv(), SETTINGS)
    expect(env).toMatchObject(KEPT)
  })

  it("gives cargowall a fixed PATH, never the job's", () => {
    expect(cargowallEnv(jobEnv(), SETTINGS).env.PATH).toBe(CARGOWALL_PATH)
    expect(cargowallEnv({}, SETTINGS).env.PATH).toBe(CARGOWALL_PATH)
  })

  it("is the action's settings and the kept classes, nothing else", () => {
    const { env } = cargowallEnv(jobEnv(), SETTINGS)
    expect(Object.keys(env).sort()).toEqual(
      [
        ...Object.keys(KEPT),
        'PATH',
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
    for (const name of LOCAL_CONFIG_VARS) expect(env[name], name).toBeUndefined()
    expect(env.PATH).toBe(CARGOWALL_PATH)
  })

  it('names the variables cargowall would have read, and only those', () => {
    const { ignored } = cargowallEnv(jobEnv(), SETTINGS)
    expect(ignored).toEqual([...CARGOWALL_READS].sort())
    expect(ignored).not.toContain('CARGOWALL_VERSION')
    expect(ignored).not.toContain('CODECARGO_OTHER_TOOL')
    expect(cargowallEnv({ PATH: '/usr/bin', CARGOWALL_VERSION: 'v2', CODECARGO_X: 'x' }, SETTINGS).ignored).toEqual([])
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
      expect(env.PATH).toBe(CARGOWALL_PATH)
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

describe('trustStoreWarning', () => {
  const job = { SSL_CERT_FILE: '/etc/corp-ca.pem', PATH: '/usr/bin' }

  // With a proxy kept and the CA dropped, a TLS connection behind a
  // TLS-intercepting proxy fails: say which variable was dropped, and what
  // the failure costs under the posture that applies.
  it('names the variables, never their values, and the cost under each failure posture', () => {
    const { trustStore } = cargowallEnv(job, SETTINGS)
    expect(trustStore).toEqual(['SSL_CERT_FILE'])
    const audit = trustStoreWarning(trustStore, 'audit', {})
    expect(audit).toContain('SSL_CERT_FILE')
    expect(audit).toContain('system trust store')
    expect(audit).toContain('audited instead of enforced')
    expect(audit).not.toContain('/etc/corp-ca.pem')
    expect(trustStoreWarning(trustStore, 'fail', {})).toContain('locked down')
    expect(trustStoreWarning(trustStore, 'local', {})).toContain("this step's own configuration applies")
    expect(trustStoreWarning(trustStore, null, { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example' })).toContain(
      'OTLP export fails'
    )
    expect(cargowallEnv({ SSL_CERT_FILE: 'a', SSL_CERT_DIR: 'b' }, SETTINGS).trustStore).toEqual(['SSL_CERT_FILE', 'SSL_CERT_DIR'])
  })

  it('says nothing when no fetch or export will happen, or the job set neither', () => {
    expect(trustStoreWarning(['SSL_CERT_FILE'], null, {})).toBeNull()
    expect(trustStoreWarning([], 'audit', {})).toBeNull()
  })
})

describe('the preserved environment', () => {
  // cargowall reads the job's Docker setup from its sudo's environment, so
  // the variables that choose the docker CLI's config stay out of its own.
  it('keeps HOME, DOCKER_CONFIG and DOCKER_CONTEXT out of what sudo preserves', () => {
    const { env, preserved: kept } = cargowallEnv({ HOME: '/home/runner', DOCKER_CONFIG: '/x', DOCKER_CONTEXT: 'c', DOCKER_HOST: 'tcp://h:2376' }, SETTINGS)
    expect(env.HOME).toBe('/home/runner')
    expect(kept.HOME).toBeUndefined()
    expect(kept.DOCKER_CONFIG).toBeUndefined()
    expect(kept.DOCKER_CONTEXT).toBeUndefined()
    expect(kept.DOCKER_HOST).toBe('tcp://h:2376')
    expect(kept.PATH).toBe(CARGOWALL_PATH)
  })

  // Root's docker CLI, without the job's HOME or DOCKER_CONFIG, would look for
  // TLS client certificates in /root/.docker: point it at the job's default.
  it("points DOCKER_CERT_PATH at the job's default certificates where TLS is on and it is unset", () => {
    const tls = { DOCKER_HOST: 'tcp://h:2376', DOCKER_TLS_VERIFY: '1' }
    expect(cargowallEnv({ ...tls, HOME: '/home/runner' }, SETTINGS).preserved.DOCKER_CERT_PATH).toBe('/home/runner/.docker')
    expect(cargowallEnv({ ...tls, HOME: '/home/runner', DOCKER_CONFIG: '/cfg' }, SETTINGS).preserved.DOCKER_CERT_PATH).toBe('/cfg')
    expect(cargowallEnv({ ...tls, HOME: '/home/runner', DOCKER_CERT_PATH: '/certs' }, SETTINGS).preserved.DOCKER_CERT_PATH).toBe('/certs')
    expect(cargowallEnv({ DOCKER_HOST: 'tcp://h:2375', DOCKER_TLS: '1', HOME: '/h' }, SETTINGS).preserved.DOCKER_CERT_PATH).toBe('/h/.docker')
    expect(cargowallEnv({ DOCKER_HOST: 'tcp://h:2375', HOME: '/h' }, SETTINGS).preserved.DOCKER_CERT_PATH).toBeUndefined()
    expect(cargowallEnv({ ...tls, DOCKER_TLS_VERIFY: '', HOME: '/h' }, SETTINGS).preserved.DOCKER_CERT_PATH).toBeUndefined()
    // The spawn's environment, the sudo process's, is the job's as it was.
    expect(cargowallEnv({ ...tls, HOME: '/home/runner' }, SETTINGS).env.DOCKER_CERT_PATH).toBeUndefined()
  })
})

describe('envWarnings', () => {
  // A blank value (an unset vars.X, say) configures nothing: no warning.
  it('ignores variables set to an empty or whitespace-only value', () => {
    const blank = { CARGOWALL_API_URL: '', CARGOWALL_TLS_SNI: '  ', SSL_CERT_FILE: '', SSL_CERT_DIR: '\t' }
    expect(cargowallEnv(blank, SETTINGS).ignored).toEqual([])
    expect(cargowallEnv(blank, SETTINGS).trustStore).toEqual([])
    expect(envWarnings(cargowallEnv(blank, SETTINGS), 'audit')).toEqual([])
  })

  it('is each warning that applies, at most once', () => {
    const w = envWarnings(cargowallEnv({ CARGOWALL_API_URL: 'https://x', SSL_CERT_FILE: '/ca.pem' }, SETTINGS), 'audit')
    expect(w).toHaveLength(2)
    expect(w[0]).toContain('CARGOWALL_API_URL')
    expect(w[1]).toContain('SSL_CERT_FILE')
    expect(envWarnings(cargowallEnv({}, SETTINGS), 'audit')).toEqual([])
  })
})
