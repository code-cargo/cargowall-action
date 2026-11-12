/**
 * This step's local configuration, as cargowall reads it when no CodeCargo
 * policy applies: either the environment variables the inputs set, or the
 * `config-file`. A CodeCargo policy that loads replaces both; cargowall never
 * reads either then.
 */
import { promises as fs } from 'fs'
import * as path from 'path'

/**
 * The variables cargowall's CI loader reads as a configuration (LoadFromEnv in
 * cargowall's pkg/config). Any one of them set makes it load the environment
 * and skip --config, so with a config file none may reach it.
 */
export const ENV_CONFIG_VARS = [
  'CARGOWALL_DEFAULT_ACTION',
  'CARGOWALL_ALLOWED_HOSTS',
  'CARGOWALL_ALLOWED_CIDRS',
  'CARGOWALL_BLOCKED_HOSTS',
  'CARGOWALL_BLOCKED_CIDRS',
  'CARGOWALL_SEARCH_DOMAINS',
] as const

/** The top-level keys of cargowall's config file (FirewallConfig). */
const CONFIG_KEYS = ['rules', 'defaultAction', 'searchDomains', 'sudoLockdown', 'steps']

/** The inputs that set the environment configuration. */
export interface EnvConfigInputs {
  allowedHosts: string
  allowedCidrs: string
  searchDomains: string
}

/**
 * The config file cargowall is given, as an absolute path, or null without
 * one. Throws, before anything on the runner changes, when the file can't
 * serve: it is missing, isn't a JSON object (cargowall reads JSON only), has a
 * top-level key cargowall doesn't know (which it would ignore, loading a
 * configuration with nothing in it), or comes with inputs it would silently
 * replace. What the keys hold, cargowall checks; see requireConfigLoaded.
 */
export async function resolveConfigFile(configFile: string, inputs: EnvConfigInputs): Promise<string | null> {
  if (!configFile) return null
  const conflicting = [
    ['allowed-hosts', inputs.allowedHosts],
    ['allowed-cidrs', inputs.allowedCidrs],
    ['search-domains', inputs.searchDomains],
  ].filter(([, value]) => value).map(([name]) => name)
  if (conflicting.length > 0) {
    throw new Error(
      `config-file can't be combined with ${conflicting.join(', ')}: the file is this step's whole ` +
        'configuration, so give those rules and search domains in it'
    )
  }
  const resolved = path.resolve(configFile)
  let raw: string
  try {
    raw = await fs.readFile(resolved, 'utf8')
  } catch (error) {
    throw new Error(`config-file ${configFile} can't be read: ${error instanceof Error ? error.message : error}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`config-file ${configFile} isn't JSON: ${error instanceof Error ? error.message : error}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`config-file ${configFile} isn't a JSON object`)
  }
  const unknown = Object.keys(parsed).filter(key => !CONFIG_KEYS.includes(key))
  if (unknown.length > 0) {
    throw new Error(
      `config-file ${configFile} has keys cargowall doesn't read: ${unknown.join(', ')} ` +
        `(it reads ${CONFIG_KEYS.join(', ')})`
    )
  }
  return resolved
}

/**
 * Throws unless cargowall's log, written since this step started it, shows a
 * configuration loaded: the CodeCargo policy, or the config file. A file
 * cargowall can't load (a rule it rejects) leaves it running deny-all with
 * only a warning in its own log, and the step must not pass on that. Keyed on
 * the two lines cargowall logs once a load succeeds (cargowall's loadCIConfig
 * and pkg/config LoadConfig), so a load that failed for any reason shows as
 * neither.
 */
export async function requireConfigLoaded(logPath: string, configFile: string): Promise<void> {
  let log = ''
  try {
    log = await fs.readFile(logPath, 'utf8')
  } catch {
    // No log to read is no evidence either way: the check below fails.
  }
  if (log.includes('Policy loaded from CodeCargo API') || log.includes('Config loaded successfully')) return
  const why = log.split('\n').find(line => line.includes('No config loaded'))
  throw new Error(
    `CargoWall did not load config-file ${configFile}, so it is running deny-all with only CI ` +
      `infrastructure allowed. Fix the file${why ? `; cargowall said: ${why.replace(/^.*?No config loaded/, 'No config loaded').trim()}` : ''}`
  )
}

/**
 * The environment cargowall starts with, as far as its local configuration
 * goes. With a config file, no configuration variable reaches it, the job's
 * own included, so it reads the file; without one, the inputs set the
 * configuration, with deny as the default action.
 */
export function localConfigEnv(base: NodeJS.ProcessEnv, configFile: string | null, inputs: EnvConfigInputs): NodeJS.ProcessEnv {
  if (configFile) {
    const env = { ...base }
    for (const name of ENV_CONFIG_VARS) delete env[name]
    return env
  }
  return {
    ...base,
    CARGOWALL_DEFAULT_ACTION: 'deny',
    ...(inputs.allowedHosts && { CARGOWALL_ALLOWED_HOSTS: inputs.allowedHosts }),
    ...(inputs.allowedCidrs && { CARGOWALL_ALLOWED_CIDRS: inputs.allowedCidrs }),
    ...(inputs.searchDomains && { CARGOWALL_SEARCH_DOMAINS: inputs.searchDomains }),
  }
}
