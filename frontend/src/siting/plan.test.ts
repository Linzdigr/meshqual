import { describe, expect, it } from 'vitest'
import { planSites, type PlanInput, type SiteNode } from './plan'
import type { DemGrid } from './terrain'

const Z = 10

function tileXY(lon: number, lat: number): [number, number] {
  const n = 2 ** Z
  const rad = (lat * Math.PI) / 180
  return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n]
}

/** Flat ground at `elev` metres over the box, with tiles from zoom Z. */
function flatDem(b: PlanInput['bbox'], elev: number): DemGrid {
  const [x0, y0] = tileXY(b.minLng - 0.5, b.maxLat + 0.5).map(Math.floor) as [number, number]
  const [x1, y1] = tileXY(b.maxLng + 0.5, b.minLat - 0.5).map(Math.floor) as [number, number]
  const tiles = []
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) tiles.push({ x, y, data: new Float32Array(256 * 256).fill(elev) })
  return { z: Z, tiles }
}

const node = (key: string, lon: number, lat: number): SiteNode => ({ key, name: key, lon, lat })

function input(nodes: SiteNode[], edges: [string, string][], bbox: PlanInput['bbox']): PlanInput {
  return { bbox, nodes, edges, dem: flatDem(bbox, 50), siteAntennaM: 10, nodeAntennaM: 10, usableSnrDb: -5 }
}

// Around Rennes: a network to the west, a pair of nodes ~30 km east.
const BBOX = { minLng: -2.0, minLat: 47.95, maxLng: -1.2, maxLat: 48.3 }
const MAIN = [node('A', -1.9, 48.1), node('B', -1.88, 48.12), node('C', -1.86, 48.1)]
const MAIN_EDGES: [string, string][] = [
  ['A', 'B'],
  ['B', 'C'],
  ['A', 'C'],
]

describe('planSites', () => {
  it('joins an island with a single site, and stops there', () => {
    const island = [node('X', -1.45, 48.1), node('Y', -1.43, 48.12)]
    const r = planSites(input([...MAIN, ...island], [...MAIN_EDGES, ['X', 'Y']], BBOX))
    expect(r.islands).toHaveLength(1)
    expect(r.islands[0]!.joined).toBe(true)
    expect(r.proposals).toHaveLength(1)
    expect(r.proposals[0]!.joins[0]!.size).toBe(2)
  })

  it('leaves alone a node only a few others hang on', () => {
    const tail = [node('D', -1.75, 48.1), node('E', -1.65, 48.1), node('F', -1.63, 48.12)]
    const r = planSites(input([...MAIN, ...tail], [...MAIN_EDGES, ['C', 'D'], ['D', 'E'], ['E', 'F']], BBOX))
    expect(r.cutNodes).toHaveLength(0)
    expect(r.proposals).toHaveLength(0)
  })

  it('proposes nothing for a well-meshed view', () => {
    const r = planSites(input(MAIN, MAIN_EDGES, BBOX))
    expect(r.proposals).toHaveLength(0)
    expect(r.islands).toHaveLength(0)
    expect(r.cutNodes).toHaveLength(0)
  })

  it('backs up a node others hang on alone', () => {
    // D holds E to I: losing D cuts them off.
    const tail = [
      node('D', -1.75, 48.1),
      node('E', -1.65, 48.1),
      node('F', -1.63, 48.12),
      node('G', -1.62, 48.09),
      node('H', -1.6, 48.11),
      node('I', -1.61, 48.13),
    ]
    const edges: [string, string][] = [
      ...MAIN_EDGES,
      ['C', 'D'],
      ['D', 'E'],
      ['E', 'F'],
      ['F', 'G'],
      ['E', 'G'],
      ['G', 'H'],
      ['H', 'I'],
      ['F', 'I'],
    ]
    // The network side must outweigh the tail for D's dependants to be the tail.
    const more = [node('J', -1.92, 48.13), node('K', -1.94, 48.11), node('L', -1.92, 48.08)]
    edges.push(['A', 'J'], ['J', 'K'], ['K', 'L'], ['L', 'A'])
    const r = planSites(input([...MAIN, ...more, ...tail], edges, BBOX))
    const d = r.cutNodes.find((c) => c.key === 'D')
    expect(d?.before).toBe(5)
    expect(d?.after).toBe(0)
    expect(r.proposals[0]!.links.length).toBeLessThanOrEqual(6)
    expect(r.proposals.length).toBeGreaterThanOrEqual(1)
    expect(r.proposals.length).toBeLessThanOrEqual(2)
  })

  it('ignores nodes with no link at all', () => {
    const r = planSites(input([...MAIN, node('Z', -1.4, 48.2)], MAIN_EDGES, BBOX))
    expect(r.unlinked).toBe(1)
    expect(r.proposals).toHaveLength(0)
  })
})
