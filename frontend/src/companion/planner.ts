/**
 * Picks round-trip traces that fill the gaps in the measurements around a
 * companion: from the repeaters it reaches directly, out along known links to
 * a link that lacks signal values, and back the same way. A round trip
 * measures both directions of every link it crosses, so one trace can fill
 * several gaps: the plan picks, step by step, the trace that fills the most.
 */

/** The link facts the planner needs, as the map's links carry them. */
export interface PlanLink {
  aKey: string
  bKey: string
  kind: string
  snrBasis?: string
  measureAgeSec?: number
}

export type Gap = 'unmeasured' | 'oneWay' | 'few' | 'stale'

export interface PlannedTrace {
  /** The trace path, out and back: R … a b a … R, starting at a reachable repeater. */
  path: string[]
  /** The link this trace was planned for. */
  target: { a: string; b: string; gap: Gap }
  /** Every link the trace crosses, as linkIds (a:b with a < b). */
  covers: string[]
}

export interface PlanOptions {
  /** Hops allowed from a reachable repeater to the near end of a target. */
  maxDepth?: number
  maxTraces?: number
  /** A link measured both ways but older than this is worth refreshing. */
  staleSec?: number
  /** The companion itself: discovery already measures its own links. */
  self?: string
  /** Nodes no trace may go through (observers, which often do not relay). */
  avoid?: ReadonlySet<string>
}

/**
 * Observers publish what they hear but often run without relaying, so a
 * trace through one dies there. Known from our brokers (the observer flags),
 * or by name for those feeding other brokers: "OBS" / "Observer" in it. One
 * seen relaying (named in a path) is a repeater with an uplink: it stays.
 */
export function isObserverName(name: string | undefined): boolean {
  return !!name && /obs/i.test(name)
}

export function observerKeys(
  nodes: { key: string; name?: string; observer?: boolean; relays?: boolean }[],
  links: {
    aKey: string
    bKey: string
    aName?: string
    bName?: string
    aObserver?: boolean
    bObserver?: boolean
    aRelays?: boolean
    bRelays?: boolean
  }[],
): Set<string> {
  const observer = new Set<string>()
  const relays = new Set<string>()
  const see = (key: string, name?: string, obs?: boolean, rel?: boolean) => {
    if (obs || isObserverName(name)) observer.add(key)
    if (rel) relays.add(key)
  }
  for (const n of nodes) see(n.key, n.name, n.observer, n.relays)
  for (const l of links) {
    see(l.aKey, l.aName, l.aObserver, l.aRelays)
    see(l.bKey, l.bName, l.bObserver, l.bRelays)
  }
  return new Set([...observer].filter((k) => !relays.has(k)))
}

/** How badly each kind of gap is missing: the weight of filling it. */
const GAP_RANK: Record<Gap, number> = { unmeasured: 4, oneWay: 3, few: 2, stale: 1 }

export const linkIdOf = (x: string, y: string) => (x <= y ? `${x}:${y}` : `${y}:${x}`)

/** What a link lacks, or null when it is measured well enough. */
export function gapOf(l: PlanLink, staleSec: number): Gap | null {
  if (l.kind === 'topology' || !l.snrBasis) return 'unmeasured'
  if (l.snrBasis === 'oneWay') return 'oneWay'
  if (l.snrBasis === 'few') return 'few'
  if ((l.measureAgeSec ?? 0) > staleSec) return 'stale'
  return null
}

export function planTraces(reachable: string[], links: PlanLink[], opts: PlanOptions = {}): PlannedTrace[] {
  const maxDepth = opts.maxDepth ?? 2
  const maxTraces = opts.maxTraces ?? 12
  const staleSec = opts.staleSec ?? 2 * 86_400
  const self = opts.self
  const avoid = opts.avoid ?? new Set<string>()
  const usable = (k: string) => k !== self && !avoid.has(k)

  // Known links are pairs that hear each other: the trace can travel them.
  const adj = new Map<string, Set<string>>()
  const add = (x: string, y: string) => {
    if (!adj.has(x)) adj.set(x, new Set())
    adj.get(x)!.add(y)
  }
  for (const l of links) {
    if (!usable(l.aKey) || !usable(l.bKey) || l.aKey === l.bKey) continue
    add(l.aKey, l.bKey)
    add(l.bKey, l.aKey)
  }

  // Breadth-first from every reachable repeater at once: the shortest way in
  // from the companion to each node, and the repeater it starts from.
  const dist = new Map<string, number>()
  const parent = new Map<string, string | null>()
  const queue: string[] = []
  for (const r of [...new Set(reachable)].sort()) {
    if (!usable(r)) continue
    dist.set(r, 0)
    parent.set(r, null)
    queue.push(r)
  }
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i]!
    const d = dist.get(n)!
    if (d >= maxDepth) continue
    for (const m of [...(adj.get(n) ?? [])].sort()) {
      if (dist.has(m)) continue
      dist.set(m, d + 1)
      parent.set(m, n)
      queue.push(m)
    }
  }
  const pathTo = (n: string) => {
    const out: string[] = []
    for (let c: string | null | undefined = n; c; c = parent.get(c)) out.unshift(c)
    return out
  }

  // Every gap within reach, and the round trip that would reach it.
  const gaps = new Map<string, Gap>()
  const options: PlannedTrace[] = []
  for (const l of links) {
    if (!usable(l.aKey) || !usable(l.bKey) || l.aKey === l.bKey) continue
    const gap = gapOf(l, staleSec)
    const da = dist.get(l.aKey)
    const db = dist.get(l.bKey)
    if (!gap || (da === undefined && db === undefined)) continue
    const nearA = db === undefined || (da !== undefined && da <= db)
    const near = nearA ? l.aKey : l.bKey
    const far = nearA ? l.bKey : l.aKey
    gaps.set(linkIdOf(near, far), gap)
    const way = pathTo(near)
    const path = [...way, far, ...[...way].reverse()]
    const covers = [...new Set(path.slice(1).map((n, k) => linkIdOf(path[k]!, n)))]
    options.push({ path, target: { a: near, b: far, gap }, covers })
  }

  // Greedy: each time, the trace filling the most still-open gaps, weighted
  // by how badly each is missing; on a tie the shorter one, since one silent
  // hop loses the whole trace.
  const open = new Set(gaps.keys())
  const gain = (t: PlannedTrace) => t.covers.reduce((g, id) => g + (open.has(id) ? GAP_RANK[gaps.get(id)!] : 0), 0)
  const plan: PlannedTrace[] = []
  while (plan.length < maxTraces && open.size > 0) {
    let best: PlannedTrace | null = null
    let bestGain = 0
    for (const t of options) {
      const g = gain(t)
      if (
        g > bestGain ||
        (g === bestGain && best && g > 0 && (t.path.length < best.path.length ||
          (t.path.length === best.path.length && t.path.join() < best.path.join())))
      ) {
        best = t
        bestGain = g
      }
    }
    if (!best) break
    plan.push(best)
    best.covers.forEach((id) => open.delete(id))
  }
  return plan
}
