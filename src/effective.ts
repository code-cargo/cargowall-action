/**
 * What the start step announces about the run's mode and sudo lockdown.
 *
 * A policy fetched from the CodeCargo API replaces this step's `mode` input,
 * and its `sudo-lockdown` input when the policy sets one, so with a policy in
 * play nothing may present the inputs as the run's posture: the posture is
 * announced once cargowall reports it, after it is ready. Without one (inputs
 * only), the inputs are the run's posture and are announced up front, as they
 * always were.
 */

export const AUDIT_NOTICE = 'CargoWall running in AUDIT MODE - connections logged but NOT blocked'

/**
 * The v2 preview notice for an enforcing run. Never alongside the audit
 * notice: announcing enforcement next to "connections logged but NOT blocked"
 * would put two contradictory annotations on the same step.
 */
export function previewNotice(mode: string, postureFlags: string[]): string | null {
  if (mode === 'audit' || !postureFlags.includes('--container-egress=enforce')) return null
  return (
    `CargoWall v2 preview enforcement is ON (${postureFlags.join(' ')}) - these knobs are ` +
    `experimental and can block traffic that an L4-only policy allowed`
  )
}

/** The notices that announce `mode` as the run's mode. */
export function modeNotices(mode: string, postureFlags: string[]): string[] {
  if (mode === 'audit') return [AUDIT_NOTICE]
  const preview = previewNotice(mode, postureFlags)
  return preview ? [preview] : []
}

/**
 * The configuration echo's mode value. Before ready nothing is known about
 * the policy, so with one in play the echo promises nothing: the input applies
 * when no policy loads (a job the platform has no policy for, say), and under
 * the `audit` or `fail` failure posture a failed fetch replaces it too.
 */
export function modeEcho(mode: string, apiFailurePosture: string | null): string {
  if (apiFailurePosture === null) return mode
  const fallback = apiFailurePosture === 'local' ? mode : `${mode}; a failed fetch uses the policy-fetch failure posture`
  return `from the CodeCargo policy if one loads (fallback: ${fallback})`
}

/**
 * The configuration echo's sudo lockdown value. A policy that sets sudo
 * lockdown replaces this step's input, and so does a config file's
 * `sudoLockdown` when no policy loads; one that doesn't leaves it standing.
 */
export function sudoLockdownEcho(sudoLockdown: boolean, apiPolicy: boolean, configFile = false): string {
  if (!apiPolicy && !configFile) return String(sudoLockdown)
  if (!apiPolicy) return `${sudoLockdown} (this step's input; the config file's sudoLockdown replaces it)`
  if (!configFile) return `${sudoLockdown} (this step's input; a CodeCargo policy that sets sudo lockdown replaces it)`
  return `${sudoLockdown} (this step's input; a CodeCargo policy that sets sudo lockdown replaces it, and the config file's does when no policy loads)`
}

/**
 * The effective mode cargowall recorded, or null when it recorded none. A
 * recorded value means cargowall took its mode from a fetched policy, or from
 * the failure posture when the fetch failed (a downgrade).
 */
export function parseModeFile(raw: string | null): 'enforce' | 'audit' | null {
  const value = raw?.trim()
  return value === 'enforce' || value === 'audit' ? value : null
}

/**
 * One layer's line in cargowall's posture record (cmd/postures.go
 * postureLine): what was asked for and what came up, as flag values.
 */
export interface PostureLine {
  posture: string
  requested: string
  applied: string
  reason?: string
}

/**
 * The posture record cargowall publishes at startup, a JSON array of
 * PostureLine, or null when it is absent or unreadable. The file sits in
 * world-writable /tmp, so only well-formed lines are kept, and every string is
 * stripped of control characters and bounded before it can reach the log.
 */
export function parsePostures(raw: string | null): PostureLine[] | null {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const clean = (v: unknown): string =>
    typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 400) : ''
  const lines: PostureLine[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue
    const l = entry as Record<string, unknown>
    const line: PostureLine = { posture: clean(l.posture), requested: clean(l.requested), applied: clean(l.applied) }
    const reason = clean(l.reason)
    if (reason) line.reason = reason
    if (line.posture) lines.push(line)
  }
  return lines
}

/**
 * The sudo lockdown cargowall applies, as the step reports it. The pinned
 * cargowall publishes its posture record before ready, and the record carries
 * a `sudo-lockdown` line whenever the flag or the policy asked for the
 * lockdown, with "true" for a lockdown that came up; anything else did not.
 * So from the pinned binary (`pinnedBinary`: neither binary-path nor
 * source-ref), a record without the line means neither asked, and the lockdown
 * is off. A binary from binary-path or source-ref may predate the line, so a
 * record without it claims nothing, as does no record this step can trust
 * (absent, stale, malformed, not an array or not root-owned; see
 * readFreshStateFile and parsePostures).
 */
export function sudoLockdownReport(args: {
  inputSudoLockdown: boolean
  policyLoaded: boolean
  pinnedBinary: boolean
  postures: PostureLine[] | null
  // A config file was given: with no policy loaded, its sudoLockdown replaces
  // the input.
  configFile?: boolean
}): string {
  const fromFile = args.configFile === true && !args.policyLoaded
  const line = args.postures?.find(l => l.posture === 'sudo-lockdown')
  if (line) {
    if (line.applied === 'true') return 'Sudo lockdown: on'
    return `Sudo lockdown: not applied${line.reason ? ` (${line.reason})` : ''}`
  }
  if (args.postures !== null && args.pinnedBinary) {
    // The input asked for it and nothing did: a loaded policy, or with none
    // the config file, turned it off.
    if (args.inputSudoLockdown && args.policyLoaded) {
      return "Sudo lockdown: off (set by the CodeCargo policy, which replaces this step's input: true)"
    }
    if (args.inputSudoLockdown && fromFile) {
      return "Sudo lockdown: off (set by the config file, which replaces this step's input: true)"
    }
    return 'Sudo lockdown: off'
  }
  const input = `this step's input: ${args.inputSudoLockdown}`
  if (fromFile) return `Sudo lockdown: not reported by cargowall (${input}, which the config file's sudoLockdown replaces)`
  if (!args.policyLoaded) return `Sudo lockdown: not reported by cargowall (${input}; no policy was loaded)`
  return `Sudo lockdown: not reported by cargowall (${input}, which a CodeCargo policy that sets sudo lockdown replaces)`
}

/** What the start step reports once cargowall is ready. */
export interface EffectiveReport {
  info: string[]
  notices: string[]
}

/**
 * The report of a run whose policy came, or was to come, from the API.
 * `effective` is what cargowall recorded (see parseModeFile). With nothing
 * recorded no policy was loaded, and cargowall runs on this step's inputs. A
 * downgrade loads no policy either, and in a run that reached ready the only
 * one is the audit fallback, so a downgrade means audit, recorded or not.
 */
export function effectiveReport(args: {
  inputMode: string
  inputSudoLockdown: boolean
  effective: 'enforce' | 'audit' | null
  downgraded: boolean
  postureFlags: string[]
  pinnedBinary: boolean
  postures: PostureLine[] | null
  configFile?: boolean
}): EffectiveReport {
  const { inputMode, effective, downgraded, postureFlags } = args
  const sudo = sudoLockdownReport({
    inputSudoLockdown: args.inputSudoLockdown,
    policyLoaded: effective !== null && !downgraded,
    pinnedBinary: args.pinnedBinary,
    postures: args.postures,
    configFile: args.configFile,
  })
  if (downgraded) {
    return {
      info: ['Mode: audit (set by the policy-fetch failure posture)', sudo],
      notices: modeNotices('audit', postureFlags),
    }
  }
  if (effective === null) {
    return {
      info: [`Mode: ${inputMode} (no policy was loaded, so this step's configuration applies; cargowall's log says why)`, sudo],
      notices: modeNotices(inputMode, postureFlags),
    }
  }
  const notices = modeNotices(effective, postureFlags)
  if (effective === 'enforce' && inputMode === 'audit') {
    notices.unshift("CargoWall is enforcing: the CodeCargo policy's mode replaces this step's `mode: audit`")
  }
  return { info: [`Mode: ${effective} (set by the CodeCargo policy)`, sudo], notices }
}
