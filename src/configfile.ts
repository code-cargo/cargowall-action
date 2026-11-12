/**
 * This step's local configuration, as cargowall reads it when no CodeCargo
 * policy applies: either the environment variables the inputs set, or the
 * `config-file`. A CodeCargo policy that loads replaces both; cargowall never
 * reads either then.
 */
import { promises as fs } from 'fs'
import { isIP } from 'net'
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

/**
 * The keys cargowall reads at each level, matched exactly: Go's decoder
 * matches a key to a field whatever its case, the last match winning, so a
 * case variant ("Protocol" beside "protocol") would reach cargowall unchecked.
 * A rule's leave out cargowall's autoAddedType on purpose: cargowall marks the
 * rules it adds itself, a policy never sets it, and a step rule that does is
 * refused by cargowall too.
 */
const RULE_KEYS = ['type', 'value', 'ports', 'action']
const PORT_KEYS = ['port', 'protocol']
const STEP_KEYS = ['id', 'rules']
const SUDO_LOCKDOWN_KEYS = ['enabled', 'allowCommands']
/** The protocols a port entry takes (cargowall's expandPorts), lowercase. */
const PROTOCOLS = ['all', 'tcp', 'udp', 'icmp']
/**
 * The rule types and actions cargowall acts on, lowercase: it drops a rule of
 * any other type, matches a job rule with any other action (or none) to
 * nothing, and reads any other default action as deny. A step rule only
 * allows, and cargowall refuses the load over any other action.
 */
const RULE_TYPES = ['hostname', 'cidr']
const ACTIONS = ['allow', 'deny']

/** The config file start() hands cargowall, as resolveConfigFile read it. */
export interface ConfigFile {
  /** Absolute, so cargowall reads the same file. */
  path: string
  /**
   * The file's `sudoLockdown.enabled` when it sets `sudoLockdown`, which then
   * replaces the sudo-lockdown input whenever no CodeCargo policy loads; null
   * when it doesn't, leaving the input in charge.
   */
  sudoLockdown: boolean | null
}

/** The inputs that set the environment configuration. */
export interface EnvConfigInputs {
  allowedHosts: string
  allowedCidrs: string
  searchDomains: string
}

/**
 * The config file cargowall is given, or null without one. Throws, before DNS
 * is touched or cargowall starts, when the file can't serve: it is missing,
 * isn't a JSON object (cargowall reads JSON only), repeats a key, has a key
 * cargowall doesn't know (which it would ignore: a misspelled "ports" makes a
 * port-scoped allow an all-ports one), has a rule cargowall would drop or
 * never match (its type, value or action, a hostname that no DNS name can
 * be), an empty port list or a port entry without one of cargowall's
 * protocols (either leaves the rule on every port), a sudo allowlist entry
 * that isn't a bare absolute path, or comes with inputs it would silently
 * replace. The rest of what the keys
 * hold, cargowall checks; see requireConfigLoaded.
 */
export async function resolveConfigFile(configFile: string, inputs: EnvConfigInputs): Promise<ConfigFile | null> {
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
  const repeated = repeatedKey(raw)
  if (repeated) {
    throw new Error(
      `config-file ${configFile}: ${repeated}; give each key once, since cargowall reads every occurrence ` +
        'and these checks only the last'
    )
  }
  const file = parsed as Record<string, unknown>
  const unknown = Object.keys(file).filter(key => !CONFIG_KEYS.includes(key))
  if (unknown.length > 0) {
    throw new Error(
      `config-file ${configFile} has keys cargowall doesn't read: ${unknown.join(', ')} ` +
        `(it reads ${CONFIG_KEYS.join(', ')})`
    )
  }
  const lockdown = file.sudoLockdown
  const problem =
    (file.defaultAction === undefined || ACTIONS.includes(file.defaultAction as string)
      ? null
      : 'defaultAction must be "allow" or "deny", in lowercase, or left out for deny: cargowall reads any other value as deny') ??
    rulesProblem(file.rules, 'rules', false) ??
    stepsProblem(file.steps) ??
    (lockdown === undefined
      ? null
      : keysProblem(lockdown, 'sudoLockdown', SUDO_LOCKDOWN_KEYS) ??
        allowCommandsProblem((lockdown as Record<string, unknown>).allowCommands))
  if (problem) throw new Error(`config-file ${configFile}: ${problem}`)
  return {
    path: resolved,
    sudoLockdown: isObject(lockdown) ? lockdown.enabled === true : null,
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** What's wrong with the object at `where`, given the keys it may have, or null. */
function keysProblem(value: unknown, where: string, keys: string[]): string | null {
  if (!isObject(value)) return `${where} isn't an object`
  const unknown = Object.keys(value).filter(key => !keys.includes(key))
  if (unknown.length === 0) return null
  return `${where} has keys cargowall doesn't read: ${unknown.join(', ')} (it reads ${keys.join(', ')}, exactly)`
}

/**
 * What's wrong with a rule list at `where`, as cargowall would read it, or
 * null. A step's rules only allow.
 */
function rulesProblem(rules: unknown, where: string, step: boolean): string | null {
  if (rules === undefined) return null
  if (!Array.isArray(rules)) return `${where} isn't a list`
  for (const [i, rule] of rules.entries()) {
    const ruleProblem = keysProblem(rule, `${where}[${i}]`, RULE_KEYS) ?? ruleValuesProblem(rule as Record<string, unknown>, `${where}[${i}]`, step)
    if (ruleProblem) return ruleProblem
    const ports = (rule as Record<string, unknown>).ports
    if (ports === undefined) continue
    if (!Array.isArray(ports)) return `${where}[${i}].ports isn't a list`
    if (ports.length === 0) return `${where}[${i}].ports is empty, which cargowall reads as every port: leave ports out for every port`
    for (const [j, port] of ports.entries()) {
      const portProblem = isObject(port) ? keysProblem(port, `${where}[${i}].ports[${j}]`, PORT_KEYS) : null
      if (portProblem) return portProblem
      if (!isObject(port) || !PROTOCOLS.includes(port.protocol as string)) {
        return (
          `${where}[${i}].ports[${j}] needs a protocol, one of ${PROTOCOLS.join(', ')} in lowercase, as in ` +
          '{"port": 443, "protocol": "tcp"}: cargowall skips a port entry without one, leaving the rule on every port'
        )
      }
    }
  }
  return null
}

/** What's wrong with a rule's type, value or action, or null. */
function ruleValuesProblem(rule: Record<string, unknown>, where: string, step: boolean): string | null {
  if (!RULE_TYPES.includes(rule.type as string)) {
    return `${where}.type must be "hostname" or "cidr", in lowercase: cargowall drops a rule of any other type`
  }
  if (typeof rule.value !== 'string' || rule.value === '') return `${where}.value must be a non-empty string`
  if (rule.type === 'hostname') {
    const problem = hostnameProblem(rule.value)
    if (problem) return `${where}.value ${JSON.stringify(rule.value)} ${problem}`
  }
  if (step) {
    if (rule.action !== undefined && rule.action !== 'allow') {
      return `${where}.action must be "allow", in lowercase, or left out: a step's rules only allow`
    }
  } else if (!ACTIONS.includes(rule.action as string)) {
    return `${where}.action must be "allow" or "deny", in lowercase: cargowall matches a job rule with any other action, or none, to nothing`
  }
  return null
}

/**
 * One label of a hostname rule's value: letters, digits, underscores and
 * hyphens, not starting or ending with a hyphen, or a whole-label `*` or `**`
 * pattern. A partial pattern such as `api-*` never matches in cargowall.
 */
const LABEL = /^(\*\*?|[A-Za-z0-9_]([A-Za-z0-9_-]*[A-Za-z0-9_])?)$/

/**
 * What's wrong with a hostname rule's value, or null. cargowall takes the
 * value as given and matches DNS names against it, so a value no query name
 * can equal loads without an error and matches nothing. Only a query name's
 * shape is admitted; the likeliest mistakes get their own message first.
 */
function hostnameProblem(value: string): string | null {
  if (isIP(value)) return 'is an IP address: give it as type cidr'
  const [address, bits, ...rest] = value.split('/')
  if (rest.length === 0 && isIP(address) && /^\d+$/.test(bits ?? '')) return 'is a CIDR: give it as type cidr'
  if (value.includes('/')) return 'is a URL or a path, not a hostname: give the host alone'
  if (value.includes(':')) return 'has a port: give the host alone and its ports in ports'
  if (value.includes(',')) return 'lists more than one host: give one host per rule'
  if (/\s/.test(value)) return 'has whitespace'
  if (value.startsWith('.')) return 'starts with a dot: leave it out, since a name already covers its subdomains'
  if (value.endsWith('.')) return 'ends with a dot: leave it out'
  if (/[^\x20-\x7e]/.test(value)) return 'has a non-ASCII character: give the punycode (xn--) form'
  if (value.length > 253) return 'is longer than 253 characters'
  const labels = value.split('.')
  for (const [i, label] of labels.entries()) {
    if (label.length > 63) return 'has a label longer than 63 characters'
    if (!LABEL.test(label)) {
      return (
        'is not a hostname: give labels of letters, digits, hyphens and underscores, or a whole-label * or **, ' +
        'separated by single dots'
      )
    }
    if (label === '**' && labels[i - 1] === '**') return 'repeats **: one ** label already matches any depth'
  }
  return null
}

/**
 * A sudo allowlist entry: an absolute path of letters, digits and `._+@/-`,
 * stricter than the characters cargowall refuses (sudoersUnsafeChars in its
 * pkg/lockdown), which leave sudoers syntax such as `:` and `=` through. A
 * comma matters before that check runs: cargowall joins the entries with
 * commas and splits them again, so an entry holding one would reach it as two
 * commands.
 */
const COMMAND_PATH = /^\/[A-Za-z0-9._+@/-]+$/

/**
 * What's wrong with sudoLockdown.allowCommands, or null. cargowall keeps only
 * the first word of an entry, so one with arguments would allow the command
 * with any arguments, and it skips one that isn't an absolute path.
 */
function allowCommandsProblem(commands: unknown): string | null {
  if (commands === undefined) return null
  if (!Array.isArray(commands)) return "sudoLockdown.allowCommands isn't a list"
  for (const [i, command] of commands.entries()) {
    if (typeof command !== 'string' || !/^\/\S+$/.test(command)) {
      return (
        `sudoLockdown.allowCommands[${i}] must be a bare absolute path, such as /usr/bin/apt-get: cargowall ` +
        'drops any arguments, which would allow the command with every argument'
      )
    }
    if (!COMMAND_PATH.test(command)) {
      return (
        `sudoLockdown.allowCommands[${i}] may hold only letters, digits and ._+@/- after its leading /: ` +
        'a comma would split it into two commands, and sudoers reads others as its own syntax'
      )
    }
  }
  return null
}

/** What's wrong with the steps' rules, or null. */
function stepsProblem(steps: unknown): string | null {
  if (steps === undefined) return null
  if (!Array.isArray(steps)) return "steps isn't a list"
  for (const [i, step] of steps.entries()) {
    const problem = keysProblem(step, `steps[${i}]`, STEP_KEYS) ?? rulesProblem((step as Record<string, unknown>).rules, `steps[${i}].rules`, true)
    if (problem) return problem
  }
  return null
}

/**
 * Where the first key an object in raw (valid JSON) repeats is, or null.
 * JSON.parse keeps a repeated key's last value, while Go's decoder decodes
 * every occurrence into the same field in turn, so cargowall would read what
 * the earlier ones set and the later one leaves out.
 */
function repeatedKey(raw: string): string | null {
  interface Frame { path: string; keys: Set<string> | null; key: string; index: number; expectKey: boolean }
  const stack: Frame[] = []
  const pathOf = (parent: Frame | undefined): string => {
    if (!parent) return ''
    if (!parent.keys) return `${parent.path}[${parent.index}]`
    return parent.path ? `${parent.path}.${parent.key}` : parent.key
  }
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    const top = stack.at(-1)
    if (c === '"') {
      let end = i + 1
      while (raw[end] !== '"') end += raw[end] === '\\' ? 2 : 1
      if (top?.keys && top.expectKey) {
        const key = JSON.parse(raw.slice(i, end + 1)) as string
        if (top.keys.has(key)) return `${top.path || 'the file'} repeats the key ${key}`
        top.keys.add(key)
        top.key = key
        top.expectKey = false
      }
      i = end
    } else if (c === '{' || c === '[') {
      stack.push({ path: pathOf(top), keys: c === '{' ? new Set() : null, key: '', index: 0, expectKey: c === '{' })
    } else if (c === '}' || c === ']') {
      stack.pop()
    } else if (c === ',' && top) {
      if (top.keys) top.expectKey = true
      else top.index++
    }
  }
  return null
}

/**
 * The lines cargowall logs once a load succeeds (cargowall's loadCIConfig and
 * pkg/config LoadConfig), in its GitHub Actions handler's form for an info
 * record: a timestamp, then the message, then its attributes. Anchored, so the
 * phrase quoted inside some other line, a load error among them, doesn't count.
 */
const FILE_LOADED = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} Config loaded successfully( |$)/
const POLICY_LOADED = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} Policy loaded from CodeCargo API( |$)/

/**
 * The errors cargowall logs for a rule it drops from a configuration that
 * still loads (pkg/config resolveRulesLocked), in its handler's form for an
 * error record, which keeps a record on one line. Anchored like the above.
 */
const DROPPED = /^::error::(Unknown Rule type|Invalid CIDR\/IP|Invalid hostname pattern)( |$)/

/**
 * Throws unless cargowall's log, written since this step started it, shows a
 * configuration loaded, the CodeCargo policy or the config file, and no
 * "No config loaded" warning; or shows the file loaded without a rule it
 * dropped. A file cargowall can't load (a rule it rejects) leaves it running
 * deny-all with only that warning in its own log, and one it loads without a
 * rule (a value it can't parse) leaves only an error there, and the step must
 * pass on neither. A policy's own dropped rules aren't the file's.
 */
export async function requireConfigLoaded(logPath: string, configFile: string): Promise<void> {
  let log = ''
  try {
    log = await fs.readFile(logPath, 'utf8')
  } catch {
    // No log to read is no evidence either way: the check below fails.
  }
  const lines = log.split('\n')
  const why = lines.find(line => line.includes('No config loaded'))
  const policy = lines.some(line => POLICY_LOADED.test(line))
  if (!why && (policy || lines.some(line => FILE_LOADED.test(line)))) {
    const dropped = policy ? [] : [...new Set(lines.filter(line => DROPPED.test(line)))]
    if (dropped.length === 0) return
    throw new Error(
      `CargoWall loaded config-file ${configFile} but dropped rules from it, so they don't apply. ` +
        `Fix the file; cargowall said: ${dropped.map(line => line.slice('::error::'.length)).join('; ')}`
    )
  }
  throw new Error(
    `CargoWall did not load config-file ${configFile}, so it is running deny-all, with only CI infrastructure ` +
      'allowed (in audit, every other connection is reported as would-deny). ' +
      `Fix the file${why ? `; cargowall said: ${why.replace(/^.*?No config loaded/, 'No config loaded').trim()}` : ''}`
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
