import { describe, it, expect } from 'vitest'
import {
  AUDIT_NOTICE,
  effectiveReport,
  modeEcho,
  modeNotices,
  parseModeFile,
  parsePostures,
  previewNotice,
  stepRulesWarning,
  sudoLockdownEcho,
  sudoLockdownReport,
} from './effective'

const PREVIEW = ['--container-egress=enforce', '--tls-sni=observe']

// The posture record exactly as cargowall marshals it (cmd/postures.go
// postureLine, json.Marshal of the ledger's lines).
const REDIRECT_LINE = '{"posture":"dns-redirect","requested":"true","applied":"true"}'
const sudoLine = (applied: string, reason?: string): string =>
  `{"posture":"sudo-lockdown","requested":"true","applied":"${applied}"${reason ? `,"reason":"${reason}"` : ''}}`

/** effectiveReport's arguments for a run whose input posture is enforce, no lockdown. */
const base = {
  inputMode: 'enforce',
  inputSudoLockdown: false,
  downgraded: false,
  postureFlags: [] as string[],
  pinnedBinary: true,
  postures: null,
}

describe('modeNotices (inputs only, announced up front as before)', () => {
  it('announces audit mode', () => {
    expect(modeNotices('audit', [])).toEqual([AUDIT_NOTICE])
  })

  it('stays silent about the preview under audit', () => {
    expect(modeNotices('audit', PREVIEW)).toEqual([AUDIT_NOTICE])
  })

  it('announces the preview for an enforcing run with container-egress enforce', () => {
    expect(modeNotices('enforce', PREVIEW)).toEqual([previewNotice('enforce', PREVIEW)])
    expect(previewNotice('enforce', PREVIEW)).toMatch(/--container-egress=enforce --tls-sni=observe/)
  })

  it('announces nothing for a plain enforcing run', () => {
    expect(modeNotices('enforce', ['--container-egress=observe'])).toEqual([])
  })
})

describe('modeEcho', () => {
  it('echoes the input unchanged without a policy', () => {
    expect(modeEcho('audit', null)).toBe('audit')
  })

  it('promises nothing before ready: the input is the fallback when no policy loads', () => {
    expect(modeEcho('audit', 'local')).toBe('from the CodeCargo policy if one loads (fallback: audit)')
  })

  it('says a failed fetch uses the failure posture when that posture replaces the input', () => {
    expect(modeEcho('enforce', 'audit')).toBe(
      'from the CodeCargo policy if one loads (fallback: enforce; a failed fetch uses the policy-fetch failure posture)'
    )
    expect(modeEcho('audit', 'fail')).toMatch(/^from the CodeCargo policy if one loads \(fallback: audit; /)
  })
})

describe('sudoLockdownEcho', () => {
  it('echoes the input unchanged without a policy', () => {
    expect(sudoLockdownEcho(false, false)).toBe('false')
  })

  it('labels the input as the input with a policy', () => {
    expect(sudoLockdownEcho(false, true)).toMatch(/^false \(this step's input; a CodeCargo policy/)
  })
})

describe('parseModeFile', () => {
  it('reads the two values cargowall writes', () => {
    expect(parseModeFile('enforce')).toBe('enforce')
    expect(parseModeFile('audit\n')).toBe('audit')
  })

  it('treats anything else as nothing recorded', () => {
    expect(parseModeFile(null)).toBeNull()
    expect(parseModeFile('')).toBeNull()
    expect(parseModeFile('lockdown')).toBeNull()
  })
})

describe('parsePostures', () => {
  it('reads the record cargowall writes', () => {
    expect(parsePostures(`[${REDIRECT_LINE},${sudoLine('false', 'sudo lockdown incomplete, /etc/sudoers could not be amended')}]`)).toEqual([
      { posture: 'dns-redirect', requested: 'true', applied: 'true' },
      {
        posture: 'sudo-lockdown',
        requested: 'true',
        applied: 'false',
        reason: 'sudo lockdown incomplete, /etc/sudoers could not be amended',
      },
    ])
  })

  it('reads an empty record, which is what nothing requested writes', () => {
    expect(parsePostures('[]')).toEqual([])
  })

  it('treats an absent or malformed record as none', () => {
    expect(parsePostures(null)).toBeNull()
    expect(parsePostures('not json')).toBeNull()
    expect(parsePostures('{"posture":"sudo-lockdown"}')).toBeNull()
  })

  it('drops entries that are not lines, and cleans what it keeps', () => {
    const planted = '[1,null,{"posture":"sudo-lockdown","requested":"true","applied":"false","reason":"bad\\u001b[31m\\nline"}]'
    expect(parsePostures(planted)).toEqual([
      { posture: 'sudo-lockdown', requested: 'true', applied: 'false', reason: 'bad [31m line' },
    ])
  })
})

const stepRulesLine = (applied: string, reason?: string): string =>
  `{"posture":"step-rules","requested":"on","applied":"${applied}"${reason ? `,"reason":"${reason}"` : ''}}`

describe('stepRulesWarning', () => {
  const OFF_REASON = "--tls-sni is off, so a step's DNS installs can't be name-scoped"
  const L7_DOWN = "L7 is not running (see the tls-sni posture), so a step's DNS installs can't be name-scoped"

  it('warns when cargowall dropped the step rules with tls-sni left off, and says what they need', () => {
    const expected =
      "CargoWall dropped the per-step allow rules (`steps`), so every step gets the job's rules alone: " +
      `${OFF_REASON}. Step rules need \`tls-sni: observe\` or above.`
    const postures = parsePostures(`[${stepRulesLine('off', OFF_REASON)}]`)
    expect(stepRulesWarning(postures, [])).toBe(expected)
    expect(stepRulesWarning(postures, ['--container-egress=observe'])).toBe(expected)
    expect(stepRulesWarning(postures, ['--tls-sni=off'])).toBe(expected)
  })

  it('gives no tls-sni hint when this step asked for L7, whatever cargowall says', () => {
    for (const flag of ['--tls-sni=observe', '--tls-sni=enforce', '--tls-sni=enforce-pinned']) {
      expect(stepRulesWarning(parsePostures(`[${stepRulesLine('off', L7_DOWN)}]`), ['--container-egress=enforce', flag])).toBe(
        `CargoWall dropped the per-step allow rules (\`steps\`), so every step gets the job's rules alone: ${L7_DOWN}.`
      )
    }
  })

  it('warns without a reason when cargowall gave none', () => {
    expect(stepRulesWarning(parsePostures(`[${stepRulesLine('off')}]`), ['--tls-sni=observe'])).toBe(
      "CargoWall dropped the per-step allow rules (`steps`), so every step gets the job's rules alone."
    )
  })

  it('says nothing when the step rules are on, the policy had none, or there is no record', () => {
    expect(stepRulesWarning(parsePostures(`[${REDIRECT_LINE},${stepRulesLine('on')}]`), ['--tls-sni=observe'])).toBeNull()
    expect(stepRulesWarning(parsePostures(`[${REDIRECT_LINE}]`), [])).toBeNull()
    expect(stepRulesWarning(null, [])).toBeNull()
  })
})

describe('sudoLockdownReport', () => {
  it('reports a lockdown that came up as on', () => {
    expect(sudoLockdownReport({ inputSudoLockdown: false, policyLoaded: true, pinnedBinary: true, postures: parsePostures(`[${sudoLine('true')}]`) }))
      .toBe('Sudo lockdown: on')
  })

  it('reads only "true" as on: a garbled value is not', () => {
    expect(sudoLockdownReport({ inputSudoLockdown: true, policyLoaded: true, pinnedBinary: true, postures: parsePostures(`[${sudoLine('yes')}]`) }))
      .toBe('Sudo lockdown: not applied')
  })

  it('reports a lockdown that did not come up as not applied, never as on', () => {
    const report = sudoLockdownReport({
      inputSudoLockdown: true,
      policyLoaded: true,
      pinnedBinary: true,
      postures: parsePostures(`[${sudoLine('false', 'visudo rejected the result')}]`),
    })
    expect(report).toBe('Sudo lockdown: not applied (visudo rejected the result)')
  })

  it('reports the lockdown off when the record has no lockdown line', () => {
    for (const raw of [`[${REDIRECT_LINE}]`, '[]']) {
      expect(sudoLockdownReport({ inputSudoLockdown: false, policyLoaded: true, pinnedBinary: true, postures: parsePostures(raw) }))
        .toBe('Sudo lockdown: off')
      expect(sudoLockdownReport({ inputSudoLockdown: false, policyLoaded: false, pinnedBinary: true, postures: parsePostures(raw) }))
        .toBe('Sudo lockdown: off')
    }
  })

  it('reports the lockdown off, blaming no policy, when none was loaded', () => {
    expect(sudoLockdownReport({ inputSudoLockdown: true, policyLoaded: false, pinnedBinary: true, postures: parsePostures(`[${REDIRECT_LINE}]`) }))
      .toBe('Sudo lockdown: off')
  })

  it('claims nothing from a missing line when the binary is not the pinned download', () => {
    // What cargowall rc.10 to rc.13 publish whatever the lockdown did: a
    // record with no lockdown line.
    const older = parsePostures(`[${REDIRECT_LINE}]`)
    expect(sudoLockdownReport({ inputSudoLockdown: true, policyLoaded: true, pinnedBinary: false, postures: older }))
      .toBe("Sudo lockdown: not reported by cargowall (this step's input: true, which a CodeCargo policy that sets sudo lockdown replaces)")
    expect(sudoLockdownReport({ inputSudoLockdown: true, policyLoaded: false, pinnedBinary: false, postures: older }))
      .toBe("Sudo lockdown: not reported by cargowall (this step's input: true; no policy was loaded)")
    expect(sudoLockdownReport({ inputSudoLockdown: true, policyLoaded: true, pinnedBinary: false, postures: parsePostures(`[${sudoLine('true')}]`) }))
      .toBe('Sudo lockdown: on')
  })

  it("names the policy when it turned off the lockdown this step's input asked for", () => {
    expect(sudoLockdownReport({ inputSudoLockdown: true, policyLoaded: true, pinnedBinary: true, postures: parsePostures(`[${REDIRECT_LINE}]`) }))
      .toBe("Sudo lockdown: off (set by the CodeCargo policy, which replaces this step's input: true)")
  })

  it('claims nothing without a record it can trust', () => {
    for (const raw of [null, 'not json', '{"posture":"sudo-lockdown"}']) {
      expect(sudoLockdownReport({ inputSudoLockdown: false, policyLoaded: true, pinnedBinary: true, postures: parsePostures(raw) }))
        .toBe("Sudo lockdown: not reported by cargowall (this step's input: false, which a CodeCargo policy that sets sudo lockdown replaces)")
    }
  })

  it('names the input, and no policy, when none was loaded', () => {
    expect(sudoLockdownReport({ inputSudoLockdown: true, policyLoaded: false, pinnedBinary: true, postures: null }))
      .toBe("Sudo lockdown: not reported by cargowall (this step's input: true; no policy was loaded)")
  })
})

describe('effectiveReport (a policy was to come from the API)', () => {
  it("reports the policy's enforce over a `mode: audit` input, and never claims nothing is blocked", () => {
    const r = effectiveReport({ ...base, inputMode: 'audit', effective: 'enforce', postures: parsePostures(`[${REDIRECT_LINE}]`) })
    expect(r.info).toEqual([
      'Mode: enforce (set by the CodeCargo policy)',
      'Sudo lockdown: off',
    ])
    expect(r.notices).toEqual([
      "CargoWall is enforcing: the CodeCargo policy's mode replaces this step's `mode: audit`",
    ])
    expect(r.notices).not.toContain(AUDIT_NOTICE)
  })

  it('reports the sudo lockdown the posture record names', () => {
    const on = effectiveReport({ ...base, effective: 'enforce', postures: parsePostures(`[${REDIRECT_LINE},${sudoLine('true')}]`) })
    expect(on.info).toContain('Sudo lockdown: on')
    const lost = effectiveReport({ ...base, effective: 'enforce', postures: parsePostures(`[${sudoLine('false')}]`) })
    expect(lost.info).toContain('Sudo lockdown: not applied')
  })

  it("announces the preview when the policy's mode enforces", () => {
    const r = effectiveReport({ ...base, inputMode: 'audit', effective: 'enforce', postureFlags: PREVIEW })
    expect(r.notices).toContain(previewNotice('enforce', PREVIEW))
  })

  it("announces audit mode when the policy's mode is audit", () => {
    const r = effectiveReport({ ...base, effective: 'audit', postureFlags: PREVIEW })
    expect(r.info[0]).toBe('Mode: audit (set by the CodeCargo policy)')
    expect(r.notices).toEqual([AUDIT_NOTICE])
  })

  it('attributes an audit fallback to the failure posture, not the policy', () => {
    const r = effectiveReport({ ...base, inputSudoLockdown: true, effective: 'audit', downgraded: true })
    expect(r.info).toEqual([
      'Mode: audit (set by the policy-fetch failure posture)',
      "Sudo lockdown: not reported by cargowall (this step's input: true; no policy was loaded)",
    ])
    expect(r.notices).toEqual([AUDIT_NOTICE])
  })

  it('reads a downgrade as audit even when its mode file is missing', () => {
    const r = effectiveReport({ ...base, inputMode: 'enforce', effective: null, downgraded: true, postureFlags: PREVIEW })
    expect(r.info[0]).toBe('Mode: audit (set by the policy-fetch failure posture)')
    expect(r.notices).toEqual([AUDIT_NOTICE])
  })

  it('reports an enforcing input plainly when the policy agrees', () => {
    const r = effectiveReport({ ...base, effective: 'enforce' })
    expect(r.info[0]).toBe('Mode: enforce (set by the CodeCargo policy)')
    expect(r.notices).toEqual([])
  })

  it('falls back to the inputs when no policy was loaded', () => {
    const r = effectiveReport({ ...base, inputMode: 'audit', effective: null })
    expect(r.info).toEqual([
      "Mode: audit (no policy was loaded, so this step's configuration applies; cargowall's log says why)",
      "Sudo lockdown: not reported by cargowall (this step's input: false; no policy was loaded)",
    ])
    expect(r.notices).toEqual([AUDIT_NOTICE])
  })
})

describe('a config file in the sudo lockdown report', () => {
  it("announces the file's lockdown when the file sets one, with a policy in play and without", () => {
    expect(sudoLockdownEcho(true, false, false)).toBe("false (set by the config file, which replaces this step's input: true)")
    expect(sudoLockdownEcho(false, false, true)).toBe("true (set by the config file, which replaces this step's input: false)")
    expect(sudoLockdownEcho(true, true, false)).toBe(
      "true (this step's input; a CodeCargo policy that sets sudo lockdown replaces it, and the config file's false does when no policy loads)"
    )
  })

  it("leaves the input in charge when the file doesn't set sudoLockdown", () => {
    expect(sudoLockdownEcho(true, false, null)).toBe('true')
    expect(sudoLockdownEcho(true, true, null)).toBe("true (this step's input; a CodeCargo policy that sets sudo lockdown replaces it)")
  })

  it('attributes an off the input asked against to the file when no policy loaded', () => {
    const record = parsePostures(`[${REDIRECT_LINE}]`)
    expect(sudoLockdownReport({ inputSudoLockdown: true, policyLoaded: false, pinnedBinary: true, postures: record, fileSetsLockdown: true }))
      .toBe("Sudo lockdown: off (set by the config file, which replaces this step's input: true)")
    // A loaded policy replaced the file, so it, not the file, turned it off.
    expect(sudoLockdownReport({ inputSudoLockdown: true, policyLoaded: true, pinnedBinary: true, postures: record, fileSetsLockdown: true }))
      .toBe("Sudo lockdown: off (set by the CodeCargo policy, which replaces this step's input: true)")
  })

  it('credits a loaded policy, not the file, when cargowall reported nothing it can trust', () => {
    expect(sudoLockdownReport({ inputSudoLockdown: true, policyLoaded: true, pinnedBinary: true, postures: null, fileSetsLockdown: true }))
      .toBe("Sudo lockdown: not reported by cargowall (this step's input: true, which a CodeCargo policy that sets sudo lockdown replaces)")
  })

  it('names the file when cargowall reported nothing it can trust', () => {
    expect(sudoLockdownReport({ inputSudoLockdown: true, policyLoaded: false, pinnedBinary: true, postures: null, fileSetsLockdown: true }))
      .toBe("Sudo lockdown: not reported by cargowall (this step's input: true, which the config file's sudoLockdown replaces)")
  })
})
