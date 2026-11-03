/** Undirected graphs as adjacency sets, keyed by node key. */
export type Adj = Map<string, Set<string>>

export function addEdge(adj: Adj, a: string, b: string) {
  if (a === b) return
  if (!adj.has(a)) adj.set(a, new Set())
  if (!adj.has(b)) adj.set(b, new Set())
  adj.get(a)!.add(b)
  adj.get(b)!.add(a)
}

export function cloneAdj(adj: Adj): Adj {
  const out: Adj = new Map()
  for (const [k, s] of adj) out.set(k, new Set(s))
  return out
}

/** Each node's connected component, numbered from 0. */
export function components(adj: Adj): Map<string, number> {
  const comp = new Map<string, number>()
  let id = 0
  for (const start of adj.keys()) {
    if (comp.has(start)) continue
    const stack = [start]
    comp.set(start, id)
    while (stack.length) {
      const v = stack.pop()!
      for (const w of adj.get(v)!) {
        if (!comp.has(w)) {
          comp.set(w, id)
          stack.push(w)
        }
      }
    }
    id++
  }
  return comp
}

/**
 * How many counted nodes `v` holds on to: removing it splits its component
 * into pieces, and these are the counted nodes outside the largest piece. Zero
 * when v is not a cut vertex.
 */
export function cutOff(adj: Adj, v: string, counted: (k: string) => boolean): number {
  const seen = new Set<string>([v])
  const pieces: number[] = []
  for (const start of adj.get(v) ?? []) {
    if (seen.has(start)) continue
    let n = 0
    const stack = [start]
    seen.add(start)
    while (stack.length) {
      const u = stack.pop()!
      if (counted(u)) n++
      for (const w of adj.get(u)!) {
        if (!seen.has(w)) {
          seen.add(w)
          stack.push(w)
        }
      }
    }
    pieces.push(n)
  }
  if (pieces.length < 2) return 0
  return pieces.reduce((a, b) => a + b, 0) - Math.max(...pieces)
}
