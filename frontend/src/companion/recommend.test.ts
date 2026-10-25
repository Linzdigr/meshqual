import { describe, expect, it } from 'vitest'
import { recommendedSteps, regionDefLine } from './recommend'

describe('regionDefLine', () => {
  it('rebuilds the tree used around Quimper', () => {
    expect(regionDefLine({ dept: '29', region: '53', commune: 'Quimper' })).toBe(
      'region def eu fr fr-bre fr-29|fr bzh|* europe',
    )
  })

  it('works for a region without an alias, and Corsica’s department codes', () => {
    expect(regionDefLine({ dept: '69', region: '84', commune: 'Lyon' })).toBe('region def eu fr fr-ara fr-69|* europe')
    expect(regionDefLine({ dept: '2A', region: '94', commune: 'Ajaccio' })).toBe('region def eu fr fr-cor fr-2a|* europe')
  })
})

describe('recommendedSteps', () => {
  it('ends with the regions when the node is located in France', () => {
    const c = recommendedSteps({ dept: '35', region: '53', commune: 'Rennes' }).map((s) => s.command)
    expect(c.slice(-4)).toEqual([
      'region def eu fr fr-bre fr-35|fr bzh|* europe',
      'region default fr',
      'region home fr',
      'region save',
    ])
    expect(c).toContain('set agc.reset.interval 4')
  })

  it('leaves the regions out elsewhere', () => {
    expect(recommendedSteps(null).some((s) => s.command.startsWith('region'))).toBe(false)
  })
})
