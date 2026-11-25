import { constants as fsConstants, promises as fs } from 'fs'
import * as path from 'path'

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
  // docker CLI uses from DOCKER_HOST, DOCKER_CONTEXT, DOCKER_CONFIG and
  // HOME, as the CLI resolves it (pkg/podenv), reading them from the
  // environment the sudo that started it was given; and its own docker
  // probe after a restart (docker info) is that CLI, which needs the TLS
  // and API-version variables beside DOCKER_HOST to reach the same daemon.
  // They describe the job's Docker, kept together; no cargowall setting is
  // bound to any of them.
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'DOCKER_TLS',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
  'DOCKER_API_VERSION',
  'HOME',
] as const

/**
 * cargowall's PATH, fixed rather than the job's. cargowall runs systemctl,
 * docker, gpasswd, visudo and resolvectl as root and finds them on it, and
 * where sudoers sets no secure_path the job's PATH would reach root,
 * $GITHUB_PATH entries the job user can write included; where sudoers does
 * set one (the hosted runners), it replaces this anyway. sudo is found on the
 * job's PATH instead (findSudo), and through sudo cargowall itself, which
 * setup installs in /usr/local/bin.
 */
export const CARGOWALL_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

/**
 * The variables of cargowall's local configuration, its LoadFromEnv: any one
 * set makes cargowall load the environment and skip --config.
 */
export const LOCAL_CONFIG_VARS = [
  'CARGOWALL_DEFAULT_ACTION',
  'CARGOWALL_ALLOWED_HOSTS',
  'CARGOWALL_ALLOWED_CIDRS',
  'CARGOWALL_BLOCKED_HOSTS',
  'CARGOWALL_BLOCKED_CIDRS',
  'CARGOWALL_SEARCH_DOMAINS',
] as const

/**
 * The variables the pinned cargowall (v2.0.0-rc.17) reads as its own
 * configuration: its kong env: tags in cmd/ and its direct reads. None
 * passes from the job; a job that sets one is told it is ignored. Re-derive
 * when the pin moves (CONTRIBUTING.md).
 */
export const CARGOWALL_READS = [
  'CARGOWALL_ALLOW_EXISTING_CONNECTIONS',
  'CARGOWALL_API_FAILURE_MODE',
  'CARGOWALL_API_URL',
  'CARGOWALL_AUDIT_LOG',
  'CARGOWALL_AUDIT_MODE',
  'CARGOWALL_AUTO_ALLOW_CLOUD_METADATA',
  'CARGOWALL_AUTO_ALLOW_GITHUB_HOSTS',
  'CARGOWALL_AUTO_ALLOW_GITLAB_HOSTS',
  'CARGOWALL_BPF_STATS',
  'CARGOWALL_CONFIG',
  'CARGOWALL_CONTAINER_EGRESS',
  'CARGOWALL_DNS_QUERY_FILTERING',
  'CARGOWALL_DNS_REDIRECT',
  'CARGOWALL_DNS_REDIRECT_IPTABLES',
  'CARGOWALL_DNS_UPSTREAM',
  'CARGOWALL_DOCKER_DNS_INTERCEPTION',
  'CARGOWALL_FAILURE_FILE',
  'CARGOWALL_GITHUB_ACTION',
  'CARGOWALL_GITLAB_CI',
  'CARGOWALL_INTERFACE',
  'CARGOWALL_JOB_KEY',
  'CARGOWALL_PIDFILE',
  'CARGOWALL_PREPOPULATE_DNS_CACHE',
  'CARGOWALL_READY_FILE',
  'CARGOWALL_RUNNER_WORKER_PID',
  'CARGOWALL_STEP_ATTRIBUTION',
  'CARGOWALL_STEP_ORDINAL_BASE',
  'CARGOWALL_SUDO_ALLOW_COMMANDS',
  'CARGOWALL_SUDO_LOCKDOWN',
  'CARGOWALL_SUDO_LOCKDOWN_USER',
  'CARGOWALL_TLS_SNI',
  'CODECARGO_AUTH_TOKEN',
  // Read directly, not through a flag.
  'CARGOWALL_CLOUD_PROVIDER',
  'CARGOWALL_AZURE_INFRA_HOSTS',
  'CARGOWALL_GITHUB_SERVICE_HOSTS',
  'CARGOWALL_GITLAB_SERVICE_HOSTS',
  ...LOCAL_CONFIG_VARS,
] as const

/**
 * The trust-store variables Go reads: never passed, since a job-set trust
 * root beside a kept proxy could redirect the policy fetch. A job that sets
 * one is told by name, because behind a TLS-intercepting proxy the fetch
 * then fails, and under the default api-failure-mode the run is audited.
 */
const TRUST_STORE_VARS = ['SSL_CERT_FILE', 'SSL_CERT_DIR'] as const

const JOB_PREFIXES = ['OTEL_EXPORTER_OTLP_'] as const


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
   * The variables the job set that cargowall would have read as its
   * configuration (CARGOWALL_READS), by name, none of which reaches it.
   * Never their values.
   */
  ignored: string[]
  /** The trust-store variables the job set, which don't reach cargowall either. */
  trustStore: string[]
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

  env.PATH = CARGOWALL_PATH
  const ignored = (CARGOWALL_READS as readonly string[]).filter(name => job[name] !== undefined).sort()
  const trustStore = TRUST_STORE_VARS.filter(name => job[name] !== undefined)
  return { env, ignored, trustStore }
}

/**
 * The variables of cargowall's local configuration (LOCAL_CONFIG_VARS). With
 * a config file, none: any one set
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
    `CargoWall ignores ${ignored.join(', ')} from the job's environment: only this step's inputs, its ` +
    'config-file and the CodeCargo policy configure it. Set what you need through one of those, where one ' +
    'covers the setting.'
  )
}

/** The one warning naming the trust-store variables cargowall doesn't get. */
export function trustStoreWarning(trustStore: string[]): string | null {
  if (trustStore.length === 0) return null
  return (
    `CargoWall doesn't pass ${trustStore.join(', ')} to cargowall: a private CA it needs, for a ` +
    'TLS-intercepting proxy say, must be in the system trust store, or its policy fetch fails ' +
    '(and under the default api-failure-mode the run is audited instead of enforced).'
  )
}

/**
 * The sudo the action starts cargowall with, found on the job's PATH: the
 * environment the spawn is given carries the fixed CARGOWALL_PATH, which
 * would otherwise be where it is looked up. Called before DNS is repointed,
 * so a host with no sudo fails before anything on it is touched.
 */
export async function findSudo(jobPath: string | undefined): Promise<string> {
  for (const dir of (jobPath ?? '').split(':')) {
    if (!dir.startsWith('/')) continue
    const candidate = path.join(dir, 'sudo')
    try {
      await fs.access(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      // not here
    }
  }
  throw new Error("sudo was not found on the job's PATH; the action starts cargowall through it")
}
