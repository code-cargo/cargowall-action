/**
 * The environment `cargowall start` runs with.
 *
 * cargowall binds most of its flags to `CARGOWALL_*` variables, so whatever
 * the job's environment carries would decide every setting this step's
 * inputs leave at cargowall's default: the workflow's and job's `env:`,
 * `$GITHUB_ENV` from an earlier step, the runner's own. A setting must come
 * from an input, the CodeCargo policy or cargowall's own default, never from
 * a variable the job happens to carry. So this is an allowlist, not a strip:
 * stripping by prefix would still pass what Go and its libraries read
 * (`SSL_CERT_FILE`, `SSL_CERT_DIR`, `GODEBUG`), and a job-set trust root with
 * a job-set proxy could redirect the policy fetch itself.
 *
 * The list is checked against what the pinned cargowall reads: its kong
 * `env:` tags, its `os.Getenv` calls and the variables the libraries it links
 * read. Re-derive it whenever the pin moves (CONTRIBUTING.md).
 */

/** Variables passed through from the job's environment by name. */
const JOB_VARS = [
  // Go's HTTP transport, for the policy fetch and OTLP export.
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  // OTLP log export (pkg/otlp); OTEL_EXPORTER_OTLP_* by prefix below.
  'OTEL_RESOURCE_ATTRIBUTES',
  'OTEL_SERVICE_NAME',
  // The runner's endpoints, which the GitHub auto-allow opens.
  'ACTIONS_RUNTIME_URL',
  'ACTIONS_RESULTS_URL',
  'ACTIONS_CACHE_URL',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  // How the job reaches Docker. cargowall identifies the daemon the job's
  // docker CLI uses from these, as the CLI resolves it (pkg/podenv), reading
  // them from the environment the sudo that started it was given. They
  // describe the job's Docker; no cargowall setting is bound to them.
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'HOME',
  // The commands cargowall runs (systemctl, docker, gpasswd, visudo,
  // resolvectl) are found on it.
  'PATH',
] as const

const JOB_PREFIXES = ['OTEL_EXPORTER_OTLP_'] as const

/** A job variable of a name cargowall reserves for its own configuration. */
const CONFIG_NAME = /^(CARGOWALL|CODECARGO)_/

export interface CargowallSettings {
  configFile: string | null
  allowedHosts: string
  allowedCidrs: string
  searchDomains: string
  githubServiceHosts: string
  azureInfraHosts: string
}

export interface CargowallEnv {
  env: NodeJS.ProcessEnv
  /**
   * The job's `CARGOWALL_*` and `CODECARGO_*` variables, by name, none of
   * which reaches cargowall: each is either one the action sets itself from
   * the inputs or one no input sets. Never their values.
   */
  ignored: string[]
}

export function cargowallEnv(job: NodeJS.ProcessEnv, settings: CargowallSettings): CargowallEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(job)) {
    if (value === undefined) continue
    if ((JOB_VARS as readonly string[]).includes(name) || JOB_PREFIXES.some(p => name.startsWith(p))) {
      env[name] = value
    }
  }

  // The action's own settings. Always set: requireNonEmptyHostList
  // guarantees the host lists are non-empty, and omitting them would hand
  // cargowall its narrower built-in defaults unannounced.
  env.CARGOWALL_GITHUB_SERVICE_HOSTS = settings.githubServiceHosts
  env.CARGOWALL_AZURE_INFRA_HOSTS = settings.azureInfraHosts
  Object.assign(env, localConfigEnv(settings))

  const ignored = Object.keys(job)
    .filter(name => job[name] !== undefined && CONFIG_NAME.test(name))
    .sort()
  return { env, ignored }
}

/**
 * The variables of cargowall's local configuration (its LoadFromEnv,
 * ENV_CONFIG_VARS in configfile.ts). With a config file, none: any one set
 * makes cargowall load the environment and skip the file. Without one, the
 * inputs, with deny as the default action. The job's own are never among
 * them.
 */
function localConfigEnv(settings: CargowallSettings): NodeJS.ProcessEnv {
  if (settings.configFile) return {}
  const env: NodeJS.ProcessEnv = { CARGOWALL_DEFAULT_ACTION: 'deny' }
  if (settings.allowedHosts) env.CARGOWALL_ALLOWED_HOSTS = settings.allowedHosts
  if (settings.allowedCidrs) env.CARGOWALL_ALLOWED_CIDRS = settings.allowedCidrs
  if (settings.searchDomains) env.CARGOWALL_SEARCH_DOMAINS = settings.searchDomains
  return env
}

/** The one warning naming the job's configuration variables cargowall ignores. */
export function ignoredVarsWarning(ignored: string[]): string | null {
  if (ignored.length === 0) return null
  return (
    `CargoWall ignores ${ignored.join(', ')} from the job's environment: only this step's inputs and ` +
    "the CodeCargo policy configure it. Set what you need through the action's inputs."
  )
}
