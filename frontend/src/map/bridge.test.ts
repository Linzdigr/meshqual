import { describe, expect, it } from 'vitest'
import { BRIDGE_LEVELS, BRIDGE_RADIUS, bridgeFill, bridgeFillExpression, bridgeRadiusExpression } from './bridge'

describe('bridge layer', () => {
  it('grows with the level, at every zoom', () => {
    const order = (['low', 'medium', 'high', 'critical'] as const).map((l) => BRIDGE_RADIUS[l])
    for (let i = 1; i < order.length; i++) {
      expect(order[i]![0]).toBeGreaterThan(order[i - 1]![0])
      expect(order[i]![1]).toBeGreaterThan(order[i - 1]![1])
    }
  })

  it('uses a distinct fill per level in both themes', () => {
    for (const dark of [false, true]) {
      const fills = BRIDGE_LEVELS.map((l) => bridgeFill(l.id, dark))
      expect(new Set(fills).size).toBe(4)
    }
  })

  it('falls back to the low style for nodes without a level', () => {
    const r = bridgeRadiusExpression()
    expect(r[3]).toBe(5)
    expect((r[4] as unknown[]).at(-1)).toBe(BRIDGE_RADIUS.low[0])
    expect(bridgeFillExpression(false).at(-1)).toBe(bridgeFill('low', false))
  })
})
