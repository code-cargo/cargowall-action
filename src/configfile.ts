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

/** The inputs that set the environment configuration. */
export interface EnvConfigInputs {
  allowedHosts: string
  allowedCidrs: string
  searchDomains: string
}

/**
 * The config file cargowall is given, as an absolute path, or null without
 * one. Throws, before anything on the runner changes, when the file can't
 * serve: it is missing, isn't JSON (cargowall reads JSON only), or comes with
 * inputs it would silently replace.
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
  try {
    JSON.parse(raw)
  } catch (error) {
    throw new Error(`config-file ${configFile} isn't JSON: ${error instanceof Error ? error.message : error}`)
  }
  return resolved
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
