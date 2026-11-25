import type { PacketHop, PacketTrace } from '@/api/types'

export type PacketRole = 'origin' | 'relay' | 'observer'

export interface PacketPath {
  /** Lines between consecutive placed nodes (gap: unknown hops between them) and the nodes, by role. */
  geojson: { type: 'FeatureCollection'; features: unknown[] }
  /** The known nodes of each reception in order, for the map focus. */
  routes: string[][]
  /** Every placed node, to frame. */
  points: [number, number][]
  /** Hops no known node answers to, or several do: on the way, not on the map. */
  unplaced: number
}

const ROLE_RANK: Record<PacketRole, number> = { relay: 0, observer: 1, origin: 2 }

const placed = (h: PacketHop): h is PacketHop & { key: string; lat: number; lon: number } =>
  !!h.key && h.lat !== undefined && h.lon !== undefined

/**
 * The way a packet went, from its receptions. A flood reception names the
 * relays in order, from the originator (when the packet names it) to the
 * observer; the receptions together draw a tree. A direct reception carries
 * the route still ahead rather than the one behind it: only its observer is
 * drawn. Unknown or ambiguous hops break nothing: the nodes either side are
 * joined by a gap line.
 */
export function packetPath(t: PacketTrace): PacketPath {
  const nodes = new Map<string, { lon: number; lat: number; name: string; role: PacketRole }>()
  const edges = new Map<string, { a: [number, number]; b: [number, number]; gap: boolean }>()
  const unknown = new Set<string>()
  const routes: string[][] = []

  const mark = (h: PacketHop & { key: string; lat: number; lon: number }, role: PacketRole) => {
    const cur = nodes.get(h.key)
    if (!cur || ROLE_RANK[role] > ROLE_RANK[cur.role]) {
      nodes.set(h.key, { lon: h.lon, lat: h.lat, name: h.name || h.key.slice(0, 8), role })
    }
  }
  if (t.origin && placed(t.origin)) mark(t.origin, 'origin')

  for (const r of t.receptions) {
    const seq: { hop: PacketHop; role: PacketRole }[] = []
    if (r.route === 'flood') {
      if (t.origin) seq.push({ hop: t.origin, role: 'origin' })
      for (const h of r.hops) seq.push({ hop: h, role: 'relay' })
    }
    if (r.observer.key) seq.push({ hop: r.observer, role: 'observer' })

    const route: string[] = []
    let last: (PacketHop & { key: string; lat: number; lon: number }) | null = null
    let skipped = 0
    for (const { hop, role } of seq) {
      if (!placed(hop)) {
        unknown.add(hop.hash ?? hop.key ?? '?')
        skipped++
        continue
      }
      if (last?.key === hop.key) {
        mark(hop, role)
        continue // a node relaying its own packet, or an observer in the path
      }
      mark(hop, role)
      if (last) {
        const id = last.key < hop.key ? `${last.key}|${hop.key}` : `${hop.key}|${last.key}`
        const gap = skipped > 0
        const cur = edges.get(id)
        // A direct sighting of the pair wins over a gap through unknown hops.
        if (!cur || (cur.gap && !gap)) edges.set(id, { a: [last.lon, last.lat], b: [hop.lon, hop.lat], gap })
      }
      route.push(hop.key)
      last = hop
      skipped = 0
    }
    if (route.length) routes.push(route)
  }

  const features: unknown[] = []
  for (const e of edges.values()) {
    features.push({ type: 'Feature', properties: { gap: e.gap }, geometry: { type: 'LineString', coordinates: [e.a, e.b] } })
  }
  for (const [key, n] of nodes) {
    features.push({
      type: 'Feature',
      properties: { key, name: n.name, role: n.role },
      geometry: { type: 'Point', coordinates: [n.lon, n.lat] },
    })
  }
  return {
    geojson: { type: 'FeatureCollection', features },
    routes,
    points: [...nodes.values()].map((n) => [n.lon, n.lat]),
    unplaced: unknown.size,
  }
}
