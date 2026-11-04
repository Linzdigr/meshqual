import type { BBox } from '@/api/types'
import { coveringTiles, loadTile } from '@/map/elevation'
import type { PlanInput, PlanResult } from './plan'
import { distanceM, type DemGrid } from './terrain'

/** Beyond this width the view is too large: too many tiles, too many sites. */
export const MAX_VIEW_KM = 150
/** At most this many elevation tiles (about 60 KB each). */
const MAX_TILES = 64

export function viewWidthKm(b: BBox): number {
  const lat = (b.minLat + b.maxLat) / 2
  return distanceM({ lon: b.minLng, lat }, { lon: b.maxLng, lat }) / 1000
}

/**
 * The elevation tiles under the view and a margin around it, for the nodes
 * just outside that links in view reach: as detailed as MAX_TILES allows, up
 * to zoom 12 (about 25 m a pixel here).
 */
export async function loadDem(b: BBox): Promise<DemGrid & { missing: number; total: number }> {
  const mx = (b.maxLng - b.minLng) * 0.15
  const my = (b.maxLat - b.minLat) * 0.15
  const wide = { minLng: b.minLng - mx, minLat: b.minLat - my, maxLng: b.maxLng + mx, maxLat: b.maxLat + my }
  const { z, tiles } = coveringTiles(wide, 13, MAX_TILES)
  const data = await Promise.all(tiles.map((t) => loadTile(t.z, t.x, t.y)))
  const loaded = tiles.flatMap((t, i) => (data[i] ? [{ x: t.x, y: t.y, data: data[i]! }] : []))
  return { z, tiles: loaded, missing: tiles.length - loaded.length, total: tiles.length }
}

/** Runs the planner in a worker; cancel() stops it. */
export function runPlan(input: PlanInput, onProgress: (step: string, done: number) => void) {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  let fail: (e: Error) => void = () => {}
  const promise = new Promise<PlanResult>((resolve, reject) => {
    fail = reject
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string; step?: string; done?: number; result?: PlanResult; message?: string }
      if (m.type === 'progress') onProgress(m.step!, m.done!)
      else {
        worker.terminate()
        if (m.type === 'done') resolve(m.result!)
        else reject(new Error(m.message))
      }
    }
    worker.onerror = (e) => {
      worker.terminate()
      reject(new Error(e.message))
    }
  })
  worker.postMessage(input)
  return {
    promise,
    cancel: () => {
      worker.terminate()
      fail(new Error('annulé'))
    },
  }
}
