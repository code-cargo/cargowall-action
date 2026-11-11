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
 * The configuration echo's mode value. With a policy in play the input is only
 * a fallback, and only under the `local` failure posture: `audit` and `fail`
 * replace it too when the policy can't be fetched.
 */
export function modeEcho(mode: string, apiFailurePosture: string | null): string {
  if (apiFailurePosture === null) return mode
  if (apiFailurePosture === 'local') return `${mode} (fallback if the policy can't be fetched)`
  return 'set by the CodeCargo policy'
}

/**
 * The configuration echo's sudo lockdown value. A policy that sets sudo
 * lockdown replaces this step's input; one that doesn't leaves it standing.
 */
export function sudoLockdownEcho(sudoLockdown: boolean, apiPolicy: boolean): string {
  if (!apiPolicy) return String(sudoLockdown)
  return `${sudoLockdown} (this step's input; a CodeCargo policy that sets sudo lockdown replaces it)`
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
 * The sudo lockdown cargowall applies, as the step reports it. The posture
 * record carries a `sudo-lockdown` line whenever the flag or the policy asked
 * for the lockdown, with "true" or "false" for what came up. A cargowall that
 * predates that line records nothing about the lockdown.
 */
export function sudoLockdownReport(args: {
  inputSudoLockdown: boolean
  policyLoaded: boolean
  postures: PostureLine[] | null
}): string {
  const line = args.postures?.find(l => l.posture === 'sudo-lockdown')
  if (line) {
    if (line.applied === 'true') return 'Sudo lockdown: on'
    return `Sudo lockdown: not applied${line.reason ? ` (${line.reason})` : ''}`
  }
  if (!args.policyLoaded) {
    return `Sudo lockdown: ${args.inputSudoLockdown} (no policy was loaded; this step's input applies)`
  }
  return 'Sudo lockdown: set by the CodeCargo policy (not reported by this cargowall version)'
}

/** What the start step reports once cargowall is ready. */
export interface EffectiveReport {
  info: string[]
  notices: string[]
}

/**
 * The report of a run whose policy came, or was to come, from the API.
 * `effective` is what cargowall recorded (see parseModeFile). With nothing
 * recorded no policy was loaded, and cargowall runs on this step's inputs; a
 * downgrade (the fetch failed) loads no policy either.
 */
export function effectiveReport(args: {
  inputMode: string
  inputSudoLockdown: boolean
  effective: 'enforce' | 'audit' | null
  downgraded: boolean
  postureFlags: string[]
  postures: PostureLine[] | null
}): EffectiveReport {
  const { inputMode, effective, downgraded, postureFlags } = args
  const sudo = sudoLockdownReport({
    inputSudoLockdown: args.inputSudoLockdown,
    policyLoaded: effective !== null && !downgraded,
    postures: args.postures,
  })
  if (effective === null) {
    return {
      info: [`Mode: ${inputMode} (no policy was loaded; this step's configuration applies)`, sudo],
      notices: modeNotices(inputMode, postureFlags),
    }
  }
  const source = downgraded ? 'the policy-fetch failure posture' : 'the CodeCargo policy'
  const notices = modeNotices(effective, postureFlags)
  if (effective === 'enforce' && inputMode === 'audit' && !downgraded) {
    notices.unshift("CargoWall is enforcing: the CodeCargo policy's mode replaces this step's `mode: audit`")
  }
  return { info: [`Mode: ${effective} (set by ${source})`, sudo], notices }
}
