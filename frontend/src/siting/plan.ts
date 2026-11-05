/**
 * Where a new repeater would help most, for the nodes and links in view.
 *
 * Only reliable links hold the network together here: a trace or measurement
 * at least usableSnrDb, or a short topology link. A zone joined to the rest
 * by unstable links only (Brocéliande and Rennes at −6 to −12 dB over 30 to
 * 50 km) counts as cut off.
 *
 * Two kinds of weakness, in this order:
 * 1. Zones cut off from the main network in view. Each gets the shortest
 *    chain of new sites (1 to MAX_CHAIN) from the zone to the network, over
 *    the high points of the view, the strongest chain among the shortest.
 * 2. Cut nodes: a node that MIN_CUT nodes or more hang on alone. A site counts
 *    only if it backs one up fully.
 *
 * Sites are added only while they resolve something, and one the others made
 * redundant is dropped at the end: as few as needed.
 *
 * Pure: runs in a worker (siting/worker.ts).
 */
import { addEdge, cloneAdj, components, cutOff, type Adj } from './graph'
import { Dem, distanceM, reach, type DemGrid, type Point } from './terrain'

export interface SiteNode extends Point {
  key: string
  name: string
  /** In the view, rather than only at the far end of a link in view. */
  inView: boolean
}

export interface SiteEdge {
  a: string
  b: string
  kind: 'measured' | 'trace' | 'topology' | string
  /** The weaker direction's median, in dB; null when not measured. */
  snr: number | null
}

export interface PlanInput {
  /** View bounds: candidate sites are searched inside. */
  bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number }
  /** Repeaters and room servers, in view or at the far end of a link in view. */
  nodes: SiteNode[]
  edges: SiteEdge[]
  dem: DemGrid
  /** Antenna height of a proposed site, and assumed at existing nodes, in m. */
  siteAntennaM: number
  nodeAntennaM: number
  /** SNR from which a link is reliable, measured or predicted, in dB. */
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
   * The links that matter (the best into each zone it joins, then the
   * strongest, KEY_LINKS at most, and those to other sites), and how many
   * nodes it would reach in all.
   */
  links: PredictedLink[]
  reaches: number
  /** Zones it is needed to join to the network. */
  joins: { names: string[]; size: number }[]
  /** Cut nodes it backs up: how many nodes no longer hang on each alone. */
  backs: { key: string; name: string; before: number; after: number }[]
}

/** A group of nodes with no reliable path to the main network in view. */
export interface Zone {
  names: string[]
  size: number
  joined: boolean
  /** The best link it has with the network today, unreliable by definition; null when none. */
  today: { from: string; to: string; kind: string; snr: number | null; distKm: number } | null
}

export interface PlanResult {
  proposals: Proposal[]
  zones: Zone[]
  cutNodes: { key: string; name: string; before: number; after: number }[]
  /** Nodes with no link at all, left out: no link is no proof of isolation. */
  unlinked: number
  /** Links in view below the reliable bar, which hold nothing together here. */
  unstable: number
  candidates: number
}

/**
 * SNR = SNR_REF_DB − path loss: 10 km in the clear ≈ +9 dB, 30 km ≈ −1 dB.
 * Not calibrated on the measured links yet: a rough figure for ranking sites.
 */
export const SNR_REF_DB = 120
/**
 * A predicted link must beat the reliable bar by this much: the model is not
 * calibrated, and a link built on a guess at the bar would come out unstable.
 */
export const PREDICTION_MARGIN_DB = 3
/** Nodes or sites beyond this are not considered for a site's links. */
export const MAX_LINK_KM = 50
/** Topology links (no SNR) count as reliable up to this length. */
export const TOPO_RELIABLE_KM = 25
/** A zone is joined by at most this many new sites in a row. */
export const MAX_CHAIN = 3
/** Sites carried from one step of a chain to the next, the strongest. */
const CHAIN_BEAM = 40
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

/** Cell sizes of the candidate lattice, in km: the finest that keeps the view within MAX_CELLS across. */
const CELL_KM = [1.5, 3, 6]
const MAX_CELLS = 60
/** Elevation sampled about every this many metres within a cell. */
const SAMPLE_M = 250
/**
 * Longitude span of a cell over its latitude span: square cells around 48° N.
 * Fixed rather than taken from the view, so that the cells do not move with it.
 */
const CELL_ASPECT = 1.5

/**
 * The high points of the view: the top of each cell, kept where no
 * neighbouring cell is higher. The cells are a fixed lattice of the globe, not
 * of the view: panning keeps the same candidates, and so the same proposals,
 * except at the edges. The cell size follows the view's width only.
 */
function candidateSites(dem: Dem, b: PlanInput['bbox']): Candidate[] {
  const mid = (b.minLat + b.maxLat) / 2
  const widthKm = distanceM({ lon: b.minLng, lat: mid }, { lon: b.maxLng, lat: mid }) / 1000
  const cellKm = CELL_KM.find((c) => widthKm / c <= MAX_CELLS) ?? CELL_KM[CELL_KM.length - 1]!
  const dy = cellKm / 111.32
  const dx = dy * CELL_ASPECT
  const sub = Math.max(4, Math.round((cellKm * 1000) / SAMPLE_M))
  // One more cell all round, for the peak test of the cells at the edges.
  const i0 = Math.floor(b.minLng / dx) - 1
  const i1 = Math.floor(b.maxLng / dx) + 1
  const j0 = Math.floor(b.minLat / dy) - 1
  const j1 = Math.floor(b.maxLat / dy) + 1
  const top = (i: number, j: number): Candidate | null => {
    let best: Candidate | null = null
    for (let sj = 0; sj < sub; sj++) {
      for (let si = 0; si < sub; si++) {
        const lon = dx * (i + (si + 0.5) / sub)
        const lat = dy * (j + (sj + 0.5) / sub)
        const e = dem.at(lon, lat)
        if (e !== null && e > 0 && (!best || e > best.elevM)) best = { id: `site-${i}:${j}`, lon, lat, elevM: e, links: [] }
      }
    }
    return best
  }
  const tops = new Map<string, Candidate | null>()
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) tops.set(`${i}:${j}`, top(i, j))
  const out: Candidate[] = []
  for (let j = j0 + 1; j < j1; j++) {
    for (let i = i0 + 1; i < i1; i++) {
      const c = tops.get(`${i}:${j}`)
      if (!c || c.lon < b.minLng || c.lon > b.maxLng || c.lat < b.minLat || c.lat > b.maxLat) continue
      let peak = true
      for (let oj = -1; oj <= 1 && peak; oj++) {
        for (let oi = -1; oi <= 1; oi++) {
          const o = tops.get(`${i + oi}:${j + oj}`)
          if (o && o !== c && o.elevM > c.elevM) {
            peak = false
            break
          }
        }
      }
      if (peak) out.push(c)
    }
  }
  return out
}

export function planSites(input: PlanInput, progress: Progress = () => {}): PlanResult {
  const dem = new Dem(input.dem)
  const byKey = new Map(input.nodes.map((n) => [n.key, n]))
  const isNode = (k: string) => byKey.has(k)
  const nameOf = (k: string) => byKey.get(k)?.name || k.slice(0, 8)
  const km = (a: string, b: string) => distanceM(byKey.get(a)!, byKey.get(b)!) / 1000

  const edges = input.edges.filter((e) => byKey.has(e.a) && byKey.has(e.b))
  const reliable = (e: SiteEdge) =>
    e.kind === 'topology' ? km(e.a, e.b) <= TOPO_RELIABLE_KM : e.snr !== null && e.snr >= input.usableSnrDb
  const G: Adj = new Map()
  for (const e of edges) if (reliable(e)) addEdge(G, e.a, e.b)
  const linked = new Set(edges.flatMap((e) => [e.a, e.b]))
  const unlinked = input.nodes.filter((n) => n.inView && !linked.has(n.key)).length
  // Nodes linked only by unstable links are in the graph too, on their own.
  for (const k of linked) if (!G.has(k)) G.set(k, new Set())

  // The main network: the component with the most nodes in view. Zones: the
  // other components with two nodes or more, one of them in view.
  const comp0 = components(G)
  const groups = new Map<number, string[]>()
  for (const [k, c] of comp0) groups.set(c, [...(groups.get(c) ?? []), k])
  const inView = (g: string[]) => g.filter((k) => byKey.get(k)!.inView).length
  const sorted = [...groups.values()].sort((x, y) => inView(y) - inView(x) || y.length - x.length)
  const main = sorted[0] ?? []
  const mainRep = main[0]
  const zones = sorted.slice(1).filter((g) => g.length >= 2 && inView(g) > 0)
  const mainSet = new Set(main)

  // Candidate sites and the reliable links each would make.
  const cands = candidateSites(dem, input.bbox)
  cands.forEach((c, i) => {
    if (i % 10 === 0) progress('Liens prévus des sites candidats', i / cands.length)
    for (const n of input.nodes) {
      if (distanceM(c, n) > MAX_LINK_KM * 1000) continue
      const r = reach(dem, c, n, input.siteAntennaM, input.nodeAntennaM)
      if (!r) continue
      const snr = snrOf(r.lossDb)
      if (snr >= input.usableSnrDb + PREDICTION_MARGIN_DB) {
        c.links.push({ key: n.key, name: n.name, lon: n.lon, lat: n.lat, distKm: r.distKm, snr, clearance: r.clearance })
      }
    }
    c.links.sort((x, y) => y.snr - x.snr)
  })

  // Links between sites, predicted on demand.
  const siteLink = new Map<string, PredictedLink | null>()
  function between(a: Candidate, b: Candidate): PredictedLink | null {
    if (a === b) return null
    const id = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`
    if (!siteLink.has(id)) {
      const r = distanceM(a, b) <= MAX_LINK_KM * 1000 ? reach(dem, a, b, input.siteAntennaM, input.siteAntennaM) : null
      const snr = r ? snrOf(r.lossDb) : -Infinity
      siteLink.set(
        id,
        r && snr >= input.usableSnrDb + PREDICTION_MARGIN_DB ? { key: '', name: '', lon: 0, lat: 0, distKm: r.distKm, snr, clearance: r.clearance } : null,
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

  function joinedZones(adj: Adj): boolean[] {
    if (mainRep === undefined) return zones.map(() => false)
    const comp = components(adj)
    const m = comp.get(mainRep)
    return zones.map((g) => comp.get(g[0]!) === m)
  }
  const zoneScore = (adj: Adj) => joinedZones(adj).reduce((s, j, i) => s + (j ? zones[i]!.length : 0), 0)

  /**
   * The fewest new sites in a row from component `from` to component `to`
   * (MAX_CHAIN at most), the strongest among those: the one whose weakest
   * link is best. Sites already proposed count as part of their component.
   */
  function bestChain(comp: Map<string, number>, from: number, to: number, sites: Candidate[]) {
    const free = cands.filter((c) => !sites.includes(c))
    const into = (c: Candidate, cid: number) => {
      let best = -Infinity
      for (const l of c.links) if (comp.get(l.key) === cid) best = Math.max(best, l.snr)
      for (const s of sites) {
        if (comp.get(s.id) !== cid) continue
        const l = between(c, s)
        if (l) best = Math.max(best, l.snr)
      }
      return best
    }
    // Each step must get closer to the network: chains do not wander.
    const toNodes = [...comp].filter(([k, c]) => c === to && isNode(k)).map(([k]) => byKey.get(k)!)
    const gapCache = new Map<Candidate, number>()
    const gap = (c: Candidate) => {
      let d = gapCache.get(c)
      if (d === undefined) {
        d = Math.min(...toNodes.map((n) => distanceM(c, n)))
        gapCache.set(c, d)
      }
      return d
    }
    type Step = { snr: number; prev: Candidate | null }
    const reached = new Map<Candidate, Step>()
    let layer = new Map<Candidate, Step>()
    for (const c of free) {
      const snr = into(c, from)
      if (snr > -Infinity) layer.set(c, { snr, prev: null })
    }
    for (const [c, st] of layer) reached.set(c, st)
    for (let depth = 1; depth <= MAX_CHAIN && layer.size; depth++) {
      let end: { c: Candidate; snr: number } | null = null
      for (const [c, st] of layer) {
        const exit = into(c, to)
        if (exit > -Infinity && (!end || Math.min(st.snr, exit) > end.snr)) end = { c, snr: Math.min(st.snr, exit) }
      }
      if (end) {
        const chain = [end.c]
        for (let p = reached.get(end.c)!.prev; p; p = reached.get(p)!.prev) chain.unshift(p)
        return { chain, snr: end.snr }
      }
      if (depth === MAX_CHAIN) break
      const next = new Map<Candidate, Step>()
      const beam = [...layer].sort((x, y) => y[1].snr - x[1].snr).slice(0, CHAIN_BEAM)
      for (const [c, st] of beam) {
        for (const d of free) {
          if (reached.has(d) || gap(d) >= gap(c) || distanceM(c, d) > MAX_LINK_KM * 1000) continue
          const l = between(c, d)
          if (!l) continue
          const snr = Math.min(st.snr, l.snr)
          const cur = next.get(d)
          if (!cur || snr > cur.snr) next.set(d, { snr, prev: c })
        }
      }
      for (const [d, st] of next) reached.set(d, st)
      layer = next
    }
    return null
  }

  // ---- Phase 1: zones cut off ---------------------------------------------
  let sites: Candidate[] = []
  while (sites.length < MAX_SITES && zones.length && mainRep !== undefined) {
    progress('Zones à relier', sites.length / MAX_SITES)
    const comp = components(withSites(sites))
    const m = comp.get(mainRep)!
    let pick: { chain: Candidate[]; snr: number; value: number } | null = null
    const tried = new Set<number>()
    for (const g of zones) {
      const zc = comp.get(g[0]!)!
      if (zc === m || tried.has(zc)) continue
      tried.add(zc) // zones merged by earlier sites are one now
      const ch = bestChain(comp, zc, m, sites)
      if (!ch) continue
      const size = zones.filter((z) => comp.get(z[0]!) === zc).reduce((s, z) => s + z.length, 0)
      const value = size / ch.chain.length
      if (!pick || value > pick.value || (value === pick.value && ch.snr > pick.snr)) pick = { ...ch, value }
    }
    if (!pick || sites.length + pick.chain.length > MAX_SITES) break
    sites = [...sites, ...pick.chain]
  }

  // ---- Phase 2: cut nodes, on the network as phase 1 left it --------------
  const G1 = withSites(sites)
  const comp1 = components(G1)
  const m1 = mainRep === undefined ? -1 : comp1.get(mainRep)
  const targets = [...G1.keys()]
    .filter((k) => isNode(k) && byKey.get(k)!.inView && comp1.get(k) === m1 && G1.get(k)!.size >= 2)
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
    for (const c of cands) {
      if (sites.includes(c)) continue
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
    if (zoneScore(without) >= zoneScore(all) && fragileScore(without) >= fragileScore(all)) {
      sites = sites.filter((x) => x !== s)
    }
  }

  // ---- What each site is for ---------------------------------------------
  const final = withSites(sites)
  const joinedFinal = joinedZones(final)
  const cutFinal = new Map(targets.map((t) => [t.key, cutOff(final, t.key, isNode)]))
  const proposals: Proposal[] = sites.map((s) => {
    const without = withSites(sites.filter((x) => x !== s))
    const joinedWithout = joinedZones(without)
    const others = sites
      .filter((o) => o !== s)
      .map((o) => ({ o, l: between(s, o) }))
      .filter((x) => x.l)
      .map(({ o, l }) => ({ ...l!, key: o.id, name: `Site ${sites.indexOf(o) + 1}`, lon: o.lon, lat: o.lat }))
    const joined = zones.filter((_, j) => joinedFinal[j] && !joinedWithout[j])
    const key: PredictedLink[] = []
    for (const g of joined) {
      const l = s.links.find((x) => g.includes(x.key)) // links are strongest first
      if (l) key.push(l)
    }
    const toMain = s.links.find((x) => mainSet.has(x.key))
    if (joined.length && toMain && !key.includes(toMain)) key.push(toMain)
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

  // The best link each zone has with the network today.
  const zoneOf = new Map<string, number>()
  zones.forEach((g, i) => g.forEach((k) => zoneOf.set(k, i)))
  const today: Zone['today'][] = zones.map(() => null)
  const rank = (snr: number | null) => (snr === null ? -100 : snr)
  for (const e of edges) {
    const [z, other] = zoneOf.has(e.a) ? [e.a, e.b] : [e.b, e.a]
    const i = zoneOf.get(z)
    if (i === undefined || !mainSet.has(other)) continue
    const cur = today[i]
    if (!cur || rank(e.snr) > rank(cur.snr)) {
      today[i] = { from: nameOf(z), to: nameOf(other), kind: e.kind, snr: e.snr, distKm: km(e.a, e.b) }
    }
  }

  return {
    proposals,
    zones: zones.map((g, j) => ({ names: g.map(nameOf), size: g.length, joined: joinedFinal[j]!, today: today[j]! })),
    cutNodes: targets.map((t) => ({ key: t.key, name: nameOf(t.key), before: t.before, after: cutFinal.get(t.key)! })),
    unlinked,
    unstable: edges.filter((e) => !reliable(e)).length,
    candidates: cands.length,
  }
}

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
