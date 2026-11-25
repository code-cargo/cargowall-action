import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import * as path from 'path'
import { CARGOWALL_PATH, CARGOWALL_READS, LOCAL_CONFIG_VARS as ENV_CONFIG_VARS, cargowallEnv, findSudo, ignoredVarsWarning, trustStoreWarning } from './env'


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
    for (const name of ENV_CONFIG_VARS) expect(env[name], name).toBeUndefined()
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
  // With a proxy kept and the CA dropped, the policy fetch behind a
  // TLS-intercepting proxy fails: say which variable was dropped.
  it('names the trust-store variables the job set, and never their values', () => {
    const { trustStore } = cargowallEnv({ SSL_CERT_FILE: '/etc/corp-ca.pem', PATH: '/usr/bin' }, SETTINGS)
    expect(trustStore).toEqual(['SSL_CERT_FILE'])
    const warning = trustStoreWarning(trustStore)
    expect(warning).toContain('SSL_CERT_FILE')
    expect(warning).toContain('system trust store')
    expect(warning).not.toContain('/etc/corp-ca.pem')
    expect(cargowallEnv({ SSL_CERT_FILE: 'a', SSL_CERT_DIR: 'b' }, SETTINGS).trustStore).toEqual(['SSL_CERT_FILE', 'SSL_CERT_DIR'])
  })

  it('says nothing when the job set neither', () => {
    expect(cargowallEnv({ PATH: '/usr/bin' }, SETTINGS).trustStore).toEqual([])
    expect(trustStoreWarning([])).toBeNull()
  })
})

describe('findSudo', () => {
  it("finds an executable sudo on the job's PATH, skipping relative entries", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'findsudo-'))
    writeFileSync(path.join(dir, 'sudo'), '#!/bin/sh\n', { mode: 0o755 })
    expect(await findSudo(`bin:/nonexistent:${dir}`)).toBe(path.join(dir, 'sudo'))
  })

  it('refuses when no PATH entry has one', async () => {
    await expect(findSudo('/nonexistent:relative')).rejects.toThrow("sudo was not found on the job's PATH")
    await expect(findSudo(undefined)).rejects.toThrow()
  })
})
