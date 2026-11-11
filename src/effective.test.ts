import { describe, it, expect } from 'vitest'
import {
  AUDIT_NOTICE,
  effectiveReport,
  modeEcho,
  modeNotices,
  parseModeFile,
  parsePostures,
  previewNotice,
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

describe('sudoLockdownReport', () => {
  it('reports a lockdown that came up as on', () => {
    expect(sudoLockdownReport({ inputSudoLockdown: false, policyLoaded: true, postures: parsePostures(`[${sudoLine('true')}]`) }))
      .toBe('Sudo lockdown: on')
  })

  it('reads only "true" as on: a garbled value is not', () => {
    expect(sudoLockdownReport({ inputSudoLockdown: true, policyLoaded: true, postures: parsePostures(`[${sudoLine('yes')}]`) }))
      .toBe('Sudo lockdown: not applied')
  })

  it('reports a lockdown that did not come up as not applied, never as on', () => {
    const report = sudoLockdownReport({
      inputSudoLockdown: true,
      policyLoaded: true,
      postures: parsePostures(`[${sudoLine('false', 'visudo rejected the result')}]`),
    })
    expect(report).toBe('Sudo lockdown: not applied (visudo rejected the result)')
  })

  it('claims nothing when cargowall records no lockdown line', () => {
    expect(sudoLockdownReport({ inputSudoLockdown: false, policyLoaded: true, postures: parsePostures(`[${REDIRECT_LINE}]`) }))
      .toBe("Sudo lockdown: not reported by cargowall (this step's input: false, which a CodeCargo policy that sets sudo lockdown replaces)")
  })

  it('names the input, and no policy, when none was loaded', () => {
    expect(sudoLockdownReport({ inputSudoLockdown: true, policyLoaded: false, postures: null }))
      .toBe("Sudo lockdown: not reported by cargowall (this step's input: true; no policy was loaded)")
  })
})

describe('effectiveReport (a policy was to come from the API)', () => {
  it("reports the policy's enforce over a `mode: audit` input, and never claims nothing is blocked", () => {
    const r = effectiveReport({ ...base, inputMode: 'audit', effective: 'enforce', postures: parsePostures(`[${REDIRECT_LINE}]`) })
    expect(r.info).toEqual([
      'Mode: enforce (set by the CodeCargo policy)',
      "Sudo lockdown: not reported by cargowall (this step's input: false, which a CodeCargo policy that sets sudo lockdown replaces)",
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
