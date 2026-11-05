import { describe, expect, it } from 'vitest'
import { demZoom } from './run'

describe('demZoom', () => {
  it('depends on the size of the view, not on where it lies', () => {
    const at = (lng: number, lat: number, w: number, h: number) => ({ minLng: lng, minLat: lat, maxLng: lng + w, maxLat: lat + h })
    for (const [w, h] of [
      [0.3, 0.15],
      [0.9, 0.45],
      [2.6, 1.3],
    ] as const) {
      const zs = new Set<number>()
      for (let k = 0; k < 200; k++) zs.add(demZoom(at(-2.4 + k * 0.0031, 48 + k * 0.0007, w, h)))
      expect(zs.size).toBe(1)
    }
    expect(demZoom(at(-2, 48, 0.3, 0.15))).toBe(12)
  })
})
