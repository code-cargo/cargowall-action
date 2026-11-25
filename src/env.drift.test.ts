import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { CARGOWALL_READS } from './env'

/**
 * Run by check-digests against the pinned binary: CARGOWALL_START_HELP names
 * a file holding `cargowall start --help`. Every CARGOWALL_ or CODECARGO_
 * variable a flag there is bound to must be in CARGOWALL_READS, so a pin bump
 * to a cargowall with a new one fails until the list is rechecked. Skipped
 * when the variable is unset, as in the unit-test run.
 */
const helpFile = process.env.CARGOWALL_START_HELP

describe.skipIf(!helpFile)('CARGOWALL_READS against the pinned binary', () => {
  it("names every variable cargowall start's flags are bound to", () => {
    const help = readFileSync(helpFile as string, 'utf8')
    const bound = [...new Set([...help.matchAll(/\$((?:CARGOWALL|CODECARGO)_[A-Z0-9_]+)/g)].map(m => m[1]))]
    expect(bound.length, 'the help output names no variables: is it the right file?').toBeGreaterThan(0)
    const reads = new Set<string>(CARGOWALL_READS)
    expect(bound.filter(name => !reads.has(name)).sort(), 'missing from CARGOWALL_READS in src/env.ts').toEqual([])
  })
})
