import { describe, expect, it } from 'vitest'
import { ALTITUDE_COLORS, coveringTiles, reliefColorExpression, stretch, terrarium } from './elevation'

describe('terrarium', () => {
  it('decodes metres from the RGB encoding', () => {
    expect(terrarium(128, 0, 0)).toBe(0)
    expect(terrarium(128, 36, 0)).toBe(36)
    expect(terrarium(127, 255, 128)).toBe(-0.5)
  })
})

describe('stretch', () => {
  it('spans the 2nd to 98th percentile, ignoring a lone outlier', () => {
    const samples = Array.from({ length: 100 }, (_, i) => 20 + i) // 20..119 m
    samples.push(900) // one mast-top artefact
    const r = stretch(samples)!
    expect(r.lo).toBeGreaterThanOrEqual(20)
    expect(r.lo).toBeLessThan(25)
    expect(r.hi).toBeLessThan(125)
  })

  it('counts the sea as 0 m and keeps a minimum span on flat ground', () => {
    expect(stretch([-40, -10, 3, 4, 5])).toEqual({ lo: 0, hi: 20 })
    expect(stretch([50, 51, 52])).toEqual({ lo: 41, hi: 61 })
  })

  it('has nothing to say without samples', () => {
    expect(stretch([])).toBeNull()
  })
})

describe('reliefColorExpression', () => {
  it('spreads the ramp evenly from lo to hi', () => {
    const e = reliefColorExpression({ lo: 10, hi: 130 })
    expect(e.slice(0, 3)).toEqual(['interpolate', ['linear'], ['elevation']])
    expect(e.slice(3, 5)).toEqual([-0.5, 'rgba(0, 0, 0, 0)']) // the sea stays clear
    expect(e[5]).toBe(10)
    expect(e[6]).toBe(ALTITUDE_COLORS[0])
    expect(e[e.length - 2]).toBe(130)
    expect(e[e.length - 1]).toBe(ALTITUDE_COLORS[ALTITUDE_COLORS.length - 1])
  })
})

describe('coveringTiles', () => {
  it('drops zoom until the view fits the tile budget', () => {
    const rennes = { minLng: -1.8, minLat: 48.0, maxLng: -1.5, maxLat: 48.2 }
    const near = coveringTiles(rennes, 12)
    expect(near.tiles.length).toBeLessThanOrEqual(16)
    const wide = coveringTiles({ minLng: -5, minLat: 47, maxLng: 0, maxLat: 49 }, 12)
    expect(wide.tiles.length).toBeLessThanOrEqual(16)
    expect(wide.z).toBeLessThan(near.z)
  })
})
