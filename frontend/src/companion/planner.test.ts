import { describe, expect, it } from 'vitest'
import { gapOf, planTraces, type PlanLink } from './planner'

const DAY = 86_400
const measured = (a: string, b: string, extra: Partial<PlanLink> = {}): PlanLink => ({
  aKey: a,
  bKey: b,
  kind: 'trace',
  snrBasis: 'both',
  measureAgeSec: 3600,
  ...extra,
})
const topo = (a: string, b: string): PlanLink => ({ aKey: a, bKey: b, kind: 'topology' })

describe('gapOf', () => {
  it('ranks what a link lacks', () => {
    expect(gapOf(topo('A', 'B'), DAY)).toBe('unmeasured')
    expect(gapOf(measured('A', 'B', { snrBasis: 'oneWay' }), DAY)).toBe('oneWay')
    expect(gapOf(measured('A', 'B', { snrBasis: 'few' }), DAY)).toBe('few')
    expect(gapOf(measured('A', 'B', { measureAgeSec: 3 * DAY }), DAY)).toBe('stale')
    expect(gapOf(measured('A', 'B'), DAY)).toBeNull()
  })
})

describe('planTraces', () => {
  // C is the companion; it reaches R directly. R–X and Y–Z are unmeasured,
  // X–Y is measured one way only, R–W is fine.
  const links = [topo('R', 'X'), measured('X', 'Y', { snrBasis: 'oneWay' }), topo('Y', 'Z'), measured('R', 'W')]

  it('fills several gaps with one trace when it can', () => {
    const plan = planTraces(['R'], links, { self: 'C', maxDepth: 2 })
    expect(plan.map((p) => p.path)).toEqual([['R', 'X', 'Y', 'Z', 'Y', 'X', 'R']])
    expect(plan[0]!.covers).toEqual(['R:X', 'X:Y', 'Y:Z'])
  })

  it('stays within the depth limit', () => {
    expect(planTraces(['R'], links, { self: 'C', maxDepth: 1 }).map((p) => p.path)).toEqual([['R', 'X', 'Y', 'X', 'R']])
    expect(planTraces(['R'], links, { self: 'C', maxDepth: 0 }).map((p) => p.path)).toEqual([['R', 'X', 'R']])
  })

  it('plans one trace per branch, within the budget', () => {
    const branches = [topo('R', 'A'), topo('R', 'B'), measured('R', 'W')]
    expect(planTraces(['R'], branches, { self: 'C' }).map((p) => p.path)).toEqual([
      ['R', 'A', 'R'],
      ['R', 'B', 'R'],
    ])
    expect(planTraces(['R'], branches, { self: 'C', maxTraces: 1 })).toHaveLength(1)
  })

  it('leaves out the companion’s own links and unreachable gaps', () => {
    const plan = planTraces(['R'], [topo('C', 'R'), topo('P', 'Q')], { self: 'C' })
    expect(plan).toEqual([])
  })

  it('starts from whichever reachable repeater gets there', () => {
    const plan = planTraces(['R1', 'R2'], [topo('R1', 'A'), topo('A', 'B'), topo('R2', 'B')], { self: 'C' })
    expect(plan.map((p) => p.path)).toEqual([
      ['R1', 'A', 'B', 'A', 'R1'], // fills R1–A and A–B together
      ['R2', 'B', 'R2'],
    ])
  })
})

describe('observers', () => {
  it('are kept out of every trace, as relay, target end or starting point', () => {
    const links = [topo('R', 'OBS'), topo('OBS', 'X'), topo('R', 'Y'), topo('O2', 'Z')]
    const plan = planTraces(['R', 'O2'], links, { self: 'C', avoid: new Set(['OBS', 'O2']) })
    expect(plan.map((p) => p.path)).toEqual([['R', 'Y', 'R']])
  })
})
