import { describe, expect, it } from 'vitest'
import type { PacketHop, PacketReception, PacketTrace } from '@/api/types'
import { packetPath } from './packetPath'

const n = (key: string, lon: number, lat: number): PacketHop => ({ key, name: key, lon, lat, hash: key.slice(0, 2) })
const A = n('AA01', -1.7, 48.1)
const B = n('BB02', -1.8, 48.0)
const C = n('CC03', -1.9, 48.05)
const O1 = n('DD04', -2.0, 48.0)
const O2 = n('EE05', -1.6, 48.2)
const rec = (observer: PacketHop, hops: PacketHop[], route: 'flood' | 'direct' = 'flood'): PacketReception => ({
  at: '2026-11-25T10:00:00Z',
  observer,
  hops,
  route,
})
const lines = (p: ReturnType<typeof packetPath>) =>
  (p.geojson.features as { properties: { gap?: boolean }; geometry: { type: string } }[]).filter((f) => f.geometry.type === 'LineString')
const roles = (p: ReturnType<typeof packetPath>) =>
  Object.fromEntries(
    (p.geojson.features as { properties: { key?: string; role?: string } }[])
      .filter((f) => f.properties.role)
      .map((f) => [f.properties.key, f.properties.role]),
  )

describe('packetPath', () => {
  it('draws the tree of the receptions from the originator', () => {
    const t: PacketTrace = { hash: 'X', payloadType: 'ADVERT', origin: A, receptions: [rec(O1, [B, C]), rec(O2, [B])] }
    const p = packetPath(t)
    expect(p.routes).toEqual([
      ['AA01', 'BB02', 'CC03', 'DD04'],
      ['AA01', 'BB02', 'EE05'],
    ])
    // A-B shared by both receptions, drawn once.
    expect(lines(p)).toHaveLength(4)
    expect(roles(p)).toEqual({ AA01: 'origin', BB02: 'relay', CC03: 'relay', DD04: 'observer', EE05: 'observer' })
    expect(p.unplaced).toBe(0)
  })

  it('bridges unknown hops with a gap line', () => {
    const t: PacketTrace = { hash: 'X', payloadType: 'TXT_MSG', receptions: [rec(O1, [B, { hash: '7F' }, { hash: '3A', ambiguous: true }, C])] }
    const p = packetPath(t)
    expect(p.unplaced).toBe(2)
    expect(lines(p).map((l) => l.properties.gap)).toEqual([true, false])
    expect(p.routes).toEqual([['BB02', 'CC03', 'DD04']])
  })

  it('draws only the observer of a direct reception', () => {
    const t: PacketTrace = { hash: 'X', payloadType: 'TXT_MSG', receptions: [rec(O1, [B, C], 'direct')] }
    const p = packetPath(t)
    expect(lines(p)).toHaveLength(0)
    expect(roles(p)).toEqual({ DD04: 'observer' })
  })

  it('does not loop on a node named twice in a row', () => {
    const t: PacketTrace = { hash: 'X', payloadType: 'ADVERT', origin: A, receptions: [rec(O1, [A, B])] }
    const p = packetPath(t)
    expect(p.routes).toEqual([['AA01', 'BB02', 'DD04']])
    expect(roles(p).AA01).toBe('origin')
  })
})
