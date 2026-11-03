/**
 * Where a new repeater would help most, for the nodes and links in view.
 *
 * Two kinds of weakness, in this order: islands (groups of nodes with no path
 * to the main network in view), then cut nodes (a node holding on its own the
 * path to several others). Candidate sites are the high points of the view;
 * each gets the links it would make with the nodes around, predicted over the
 * terrain (terrain.ts). Sites are added one at a time, the one resolving most
 * first, and only while one still resolves something: as few as needed, and
 * a site the others made redundant is dropped at the end.
 *
 * Pure: runs in a worker (siting/worker.ts).
 */
import { addEdge, cloneAdj, components, cutOff, type Adj } from './graph'
import { Dem, distanceM, reach, type DemGrid, type Point } from './terrain'

export interface SiteNode extends Point {
  key: string
  name: string
}

export interface PlanInput {
  /** View bounds: candidate sites are searched inside. */
  bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number }
  /** Repeaters and room servers, in view or at the far end of a link in view. */
  nodes: SiteNode[]
  /** Links between them (any kind: each proves the two hear each other). */
  edges: [string, string][]
  dem: DemGrid
  /** Antenna height of a proposed site, and assumed at existing nodes, in m. */
  siteAntennaM: number
  nodeAntennaM: number
  /** Predicted SNR from which a link counts, in dB. */
  usableSnrDb: number
}

export interface PredictedLink extends Point {
  key: string
  name: string
  distKm: number
  snr: number
  clearance: number
}

export interface Proposal extends Point {
  id: string
  elevM: number
  /**
   * The links that matter (the best into each island it joins, then the
   * strongest, KEY_LINKS at most, and those to other sites), and how many
   * nodes it would reach in all.
   */
  links: PredictedLink[]
  reaches: number
  /** Islands it is needed to join to the network. */
  joins: { names: string[]; size: number }[]
  /** Cut nodes it backs up: how many nodes no longer hang on each alone. */
  backs: { key: string; name: string; before: number; after: number }[]
}

export interface PlanResult {
  proposals: Proposal[]
  /** Weaknesses found in view, and those no site could resolve. */
  islands: { names: string[]; size: number; joined: boolean }[]
  cutNodes: { key: string; name: string; before: number; after: number }[]
  /** Nodes with no link at all, left out (see below). */
  unlinked: number
  candidates: number
}

/**
 * SNR = SNR_REF_DB − path loss: 10 km in the clear ≈ +9 dB, 30 km ≈ −1 dB.
 * Not calibrated on the measured links yet: a rough figure for ranking sites.
 */
export const SNR_REF_DB = 120
/** Nodes beyond this are not considered for a site's links. */
export const MAX_LINK_KM = 50
/** A cut node is a weakness from this many nodes hanging on it. */
export const MIN_CUT = 5
/** Links shown per site. */
export const KEY_LINKS = 6
/** Hard cap: never this many sites in one view. */
export const MAX_SITES = 8

type Progress = (step: string, done: number) => void

interface Candidate extends Point {
  id: string
  elevM: number
  links: PredictedLink[]
}

const snrOf = (lossDb: number) => SNR_REF_DB - lossDb

/** The high points of the view: the top of each cell, kept where no neighbouring cell is higher. */
function candidateSites(dem: Dem, b: PlanInput['bbox']): Candidate[] {
  const widthKm = distanceM({ lon: b.minLng, lat: (b.minLat + b.maxLat) / 2 }, { lon: b.maxLng, lat: (b.minLat + b.maxLat) / 2 }) / 1000
  const heightKm = distanceM({ lon: b.minLng, lat: b.minLat }, { lon: b.minLng, lat: b.maxLat }) / 1000
  const nx = Math.max(6, Math.min(32, Math.round(widthKm / 1.5)))
  const ny = Math.max(6, Math.min(32, Math.round(heightKm / 1.5)))
  const dx = (b.maxLng - b.minLng) / nx
  const dy = (b.maxLat - b.minLat) / ny
  const SUB = 6
  const tops: (Candidate | null)[][] = []
  for (let j = 0; j < ny; j++) {
    const row: (Candidate | null)[] = []
    for (let i = 0; i < nx; i++) {
      let best: Candidate | null = null
      for (let sj = 0; sj < SUB; sj++) {
        for (let si = 0; si < SUB; si++) {
          const lon = b.minLng + dx * (i + (si + 0.5) / SUB)
          const lat = b.minLat + dy * (j + (sj + 0.5) / SUB)
          const e = dem.at(lon, lat)
          if (e !== null && e > 0 && (!best || e > best.elevM)) best = { id: '', lon, lat, elevM: e, links: [] }
        }
      }
      row.push(best)
    }
    tops.push(row)
  }
  const out: Candidate[] = []
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = tops[j]![i]
      if (!c) continue
      let peak = true
      for (let oj = -1; oj <= 1 && peak; oj++) {
        for (let oi = -1; oi <= 1; oi++) {
          const o = tops[j + oj]?.[i + oi]
          if (o && o !== c && o.elevM > c.elevM) {
            peak = false
            break
          }
        }
      }
      if (peak) out.push({ ...c, id: `site-${out.length}` })
    }
  }
  return out
}

export function planSites(input: PlanInput, progress: Progress = () => {}): PlanResult {
  const dem = new Dem(input.dem)
  const byKey = new Map(input.nodes.map((n) => [n.key, n]))
  const isNode = (k: string) => byKey.has(k)

  const G: Adj = new Map()
  for (const [a, b] of input.edges) if (byKey.has(a) && byKey.has(b)) addEdge(G, a, b)
  const unlinked = input.nodes.filter((n) => !G.has(n.key)).length

  // Islands: every component but the largest. Nodes with no link at all are
  // left out: no link is no proof of isolation (1-byte hashes, never relayed).
  const comp0 = components(G)
  const groups = new Map<number, string[]>()
  for (const [k, c] of comp0) groups.set(c, [...(groups.get(c) ?? []), k])
  const sorted = [...groups.values()].sort((x, y) => y.length - x.length)
  const main = sorted[0] ?? []
  const islands = sorted.slice(1).filter((g) => g.length >= 2)
  const mainRep = main[0]

  // Candidate sites and the links each would make.
  const cands = candidateSites(dem, input.bbox)
  cands.forEach((c, i) => {
    if (i % 10 === 0) progress('Liens prévus des sites candidats', i / cands.length)
    for (const n of input.nodes) {
      if (distanceM(c, n) > MAX_LINK_KM * 1000) continue
      const r = reach(dem, c, n, input.siteAntennaM, input.nodeAntennaM)
      if (!r) continue
      const snr = snrOf(r.lossDb)
      if (snr >= input.usableSnrDb) {
        c.links.push({ key: n.key, name: n.name, lon: n.lon, lat: n.lat, distKm: r.distKm, snr, clearance: r.clearance })
      }
    }
    c.links.sort((x, y) => y.snr - x.snr)
  })
  const pool = cands.filter((c) => c.links.length > 0)

  // Links between proposed sites, predicted on demand.
  const siteLink = new Map<string, PredictedLink | null>()
  function between(a: Candidate, b: Candidate): PredictedLink | null {
    const id = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`
    if (!siteLink.has(id)) {
      const r = distanceM(a, b) <= MAX_LINK_KM * 1000 ? reach(dem, a, b, input.siteAntennaM, input.siteAntennaM) : null
      const snr = r ? snrOf(r.lossDb) : -Infinity
      siteLink.set(
        id,
        r && snr >= input.usableSnrDb ? { key: '', name: '', lon: 0, lat: 0, distKm: r.distKm, snr, clearance: r.clearance } : null,
      )
    }
    return siteLink.get(id)!
  }

  function withSites(sites: Candidate[]): Adj {
    const adj = cloneAdj(G)
    for (const s of sites) {
      adj.set(s.id, adj.get(s.id) ?? new Set())
      for (const l of s.links) addEdge(adj, s.id, l.key)
    }
    for (let i = 0; i < sites.length; i++) {
      for (let j = i + 1; j < sites.length; j++) if (between(sites[i]!, sites[j]!)) addEdge(adj, sites[i]!.id, sites[j]!.id)
    }
    return adj
  }

  function joinedIslands(adj: Adj): boolean[] {
    if (mainRep === undefined) return islands.map(() => false)
    const comp = components(adj)
    const m = comp.get(mainRep)
    return islands.map((g) => comp.get(g[0]!) === m)
  }
  const islandScore = (adj: Adj) => joinedIslands(adj).reduce((s, j, i) => s + (j ? islands[i]!.length : 0), 0)

  // ---- Phase 1: islands -------------------------------------------------
  let sites: Candidate[] = []
  const unused = () => pool.filter((c) => !sites.includes(c))
  while (sites.length < MAX_SITES && islands.length) {
    progress('Îlots à relier', sites.length / MAX_SITES)
    const base = islandScore(withSites(sites))
    if (base === islands.reduce((s, g) => s + g.length, 0)) break
    let best: Candidate[] | null = null
    let bestGain = 0
    for (const c of unused()) {
      const gain = islandScore(withSites([...sites, c])) - base
      if (gain > bestGain) [best, bestGain] = [[c], gain]
    }
    // No single site reaches both sides: try a relay pair, one site by the
    // island, one by the network, the two in range of each other.
    if (!best) {
      const adj = withSites(sites)
      const comp = components(adj)
      const m = mainRep === undefined ? -1 : comp.get(mainRep)
      const joined = joinedIslands(adj)
      for (const [i, g] of islands.entries()) {
        if (joined[i]) continue
        const inG = new Set(g)
        const centre = { lon: avg(g.map((k) => byKey.get(k)!.lon)), lat: avg(g.map((k) => byKey.get(k)!.lat)) }
        const near = unused()
          .filter((c) => c.links.some((l) => inG.has(l.key)))
          .sort((x, y) => bestSnr(y, inG) - bestSnr(x, inG))
          .slice(0, 8)
        const far = unused()
          .filter((c) => c.links.some((l) => comp.get(l.key) === m))
          .sort((x, y) => distanceM(x, centre) - distanceM(y, centre))
          .slice(0, 8)
        for (const a of near) {
          for (const b of far) {
            if (a === b || !between(a, b)) continue
            const gain = islandScore(withSites([...sites, a, b])) - base
            if (gain > bestGain) [best, bestGain] = [[a, b], gain]
          }
        }
      }
    }
    if (!best) break
    sites = [...sites, ...best]
  }

  // ---- Phase 2: cut nodes, on the network as phase 1 left it -------------
  const G1 = withSites(sites)
  const comp1 = components(G1)
  const m1 = mainRep === undefined ? -1 : comp1.get(mainRep)
  const targets = [...G1.keys()]
    .filter((k) => isNode(k) && comp1.get(k) === m1 && G1.get(k)!.size >= 2)
    .map((k) => ({ key: k, before: cutOff(G1, k, isNode) }))
    .filter((t) => t.before >= MIN_CUT)
  // Only a node fully backed up counts (fewer than MIN_CUT still hanging on
  // it): a site that merely trims a dependency is not worth building.
  const fragileScore = (adj: Adj) => targets.reduce((s, t) => s + (cutOff(adj, t.key, isNode) < MIN_CUT ? t.before : 0), 0)
  while (sites.length < MAX_SITES && targets.length) {
    progress('Points de passage obligés', sites.length / MAX_SITES)
    const base = fragileScore(withSites(sites))
    let best: Candidate | null = null
    let bestGain = 0
    for (const c of unused()) {
      // A site backs up a node only through two links or more into the network.
      if (c.links.filter((l) => comp1.get(l.key) === m1).length < 2) continue
      const gain = fragileScore(withSites([...sites, c])) - base
      if (gain > bestGain) [best, bestGain] = [c, gain]
    }
    if (!best) break
    sites = [...sites, best]
  }

  // ---- Drop sites the others made redundant -------------------------------
  for (const s of [...sites].reverse()) {
    const all = withSites(sites)
    const without = withSites(sites.filter((x) => x !== s))
    if (islandScore(without) >= islandScore(all) && fragileScore(without) >= fragileScore(all)) {
      sites = sites.filter((x) => x !== s)
    }
  }

  // ---- What each site is for ---------------------------------------------
  const final = withSites(sites)
  const joinedFinal = joinedIslands(final)
  const cutFinal = new Map(targets.map((t) => [t.key, cutOff(final, t.key, isNode)]))
  const nameOf = (k: string) => byKey.get(k)?.name || k.slice(0, 8)
  const proposals: Proposal[] = sites.map((s) => {
    const without = withSites(sites.filter((x) => x !== s))
    const joinedWithout = joinedIslands(without)
    const others = sites
      .filter((o) => o !== s)
      .map((o) => ({ o, l: between(s, o) }))
      .filter((x) => x.l)
      .map(({ o, l }) => ({ ...l!, key: o.id, name: `Site ${sites.indexOf(o) + 1}`, lon: o.lon, lat: o.lat }))
    const joined = islands.filter((_, j) => joinedFinal[j] && !joinedWithout[j])
    const key: PredictedLink[] = []
    for (const g of joined) {
      const into = s.links.find((l) => g.includes(l.key)) // links are strongest first
      if (into) key.push(into)
    }
    for (const l of s.links) if (key.length < KEY_LINKS && !key.includes(l)) key.push(l)
    return {
      id: s.id,
      lon: s.lon,
      lat: s.lat,
      elevM: Math.round(s.elevM),
      links: [...key.sort((x, y) => y.snr - x.snr), ...others],
      reaches: s.links.length,
      joins: joined.map((g) => ({ names: g.map(nameOf), size: g.length })),
      backs: targets
        .map((t) => ({ t, after: cutFinal.get(t.key)!, without: cutOff(without, t.key, isNode) }))
        .filter((x) => x.after < MIN_CUT && x.without >= MIN_CUT)
        .map(({ t, after }) => ({ key: t.key, name: nameOf(t.key), before: t.before, after })),
    }
  })

  return {
    proposals,
    islands: islands.map((g, j) => ({ names: g.map(nameOf), size: g.length, joined: joinedFinal[j]! })),
    cutNodes: targets.map((t) => ({ key: t.key, name: nameOf(t.key), before: t.before, after: cutFinal.get(t.key)! })),
    unlinked,
    candidates: pool.length,
  }
}

const avg = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length
const bestSnr = (c: Candidate, keys: Set<string>) => Math.max(...c.links.filter((l) => keys.has(l.key)).map((l) => l.snr))

/** The sites and their predicted links, for the map. */
export function sitesGeoJSON(result: PlanResult | null, selected: string | null) {
  const features: unknown[] = []
  for (const [i, p] of (result?.proposals ?? []).entries()) {
    const dim = selected !== null && selected !== p.id
    for (const l of p.links) {
      // A link between two sites is drawn once, from the first.
      if (l.key.startsWith('site-') && l.key < p.id) continue
      features.push({
        type: 'Feature',
        properties: { site: p.id, dim },
        geometry: { type: 'LineString', coordinates: [[p.lon, p.lat], [l.lon, l.lat]] },
      })
    }
    features.push({
      type: 'Feature',
      properties: { site: p.id, n: String(i + 1), dim },
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    })
  }
  return { type: 'FeatureCollection' as const, features }
}
