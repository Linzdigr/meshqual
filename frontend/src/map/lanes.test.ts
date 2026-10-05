import { describe, expect, it } from 'vitest'
import type { Feature, FeatureCollection, LinkProperties } from '@/api/types'
import { buildLanes, isAsymmetric, isFunctional, laneId } from './lanes'

function link(p: Partial<LinkProperties>): Feature<LinkProperties> {
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: [[1, 1], [2, 2]] },
    properties: {
      linkId: 'A:B', aKey: 'A', bKey: 'B', aName: 'a', bName: 'b', kind: 'measured',
      samples: 10, forward: 5, backward: 5, lastSeen: '', ageSec: 0, lastForward: true,
      distKm: 1, weight: 1, ...p,
    },
  }
}

const fc = (...f: Feature<LinkProperties>[]): FeatureCollection<LinkProperties> => ({
  type: 'FeatureCollection',
  features: f,
})

describe('buildLanes', () => {
  it('gives each direction its own lane, oriented in its direction of travel', () => {
    const lanes = buildLanes(fc(link({ snrMedianAB: 10, snrCountAB: 4, snrMedianBA: -8, snrCountBA: 3 })), 6)
    expect(lanes.features).toHaveLength(2)
    const [ab, ba] = lanes.features
    expect(ab!.properties).toMatchObject({ laneId: laneId('A:B', true), snr: 10, measured: true })
    expect(ba!.properties).toMatchObject({ laneId: laneId('A:B', false), snr: -8, measured: true })
    expect((ab!.geometry as { coordinates: number[][] }).coordinates).toEqual([[1, 1], [2, 2]])
    expect((ba!.geometry as { coordinates: number[][] }).coordinates).toEqual([[2, 2], [1, 1]])
  })

  it('marks a direction never measured instead of inventing a colour', () => {
    const lanes = buildLanes(fc(link({ snrMedianAB: 10, snrCountAB: 4 })), 6)
    const ba = lanes.features[1]!.properties
    expect(ba.measured).toBe(false)
    expect(ba).not.toHaveProperty('snr')
  })

  it('draws no lanes for topology links, which have no SNR either way', () => {
    expect(buildLanes(fc(link({ kind: 'topology' })), 6).features).toHaveLength(0)
  })

  it('emphasizes a link only when both directions are compared and differ enough', () => {
    const asym = link({ snrBasis: 'both', snrDelta: -7.5 })
    const sym = link({ snrBasis: 'both', snrDelta: 2 })
    const oneWay = link({ snrBasis: 'oneWay' })
    expect(isAsymmetric(asym.properties, 6)).toBe(true)
    expect(isAsymmetric(sym.properties, 6)).toBe(false)
    expect(isAsymmetric(oneWay.properties, 6)).toBe(false)
    expect(buildLanes(fc(asym), 6).features.every((f) => f.properties.emphasized)).toBe(true)
  })
})

describe('isFunctional', () => {
  const T = [-12, -5, 5]
  it('needs both directions measured, the weaker at the usable threshold or above', () => {
    expect(isFunctional(link({ snrBasis: 'both', snrQuality: -5 }).properties, T)).toBe(true)
    expect(isFunctional(link({ snrBasis: 'both', snrQuality: -5.25 }).properties, T)).toBe(false)
  })

  it('rejects a strong link measured one way only, or with too few samples', () => {
    expect(isFunctional(link({ snrBasis: 'oneWay', snrQuality: 12 }).properties, T)).toBe(false)
    expect(isFunctional(link({ snrBasis: 'few', snrQuality: 12 }).properties, T)).toBe(false)
    expect(isFunctional(link({ kind: 'topology' }).properties, T)).toBe(false)
  })
})
