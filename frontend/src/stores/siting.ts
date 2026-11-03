import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import type { BBox } from '@/api/types'
import { useMeshStore } from '@/stores/mesh'
import type { PlanResult, SiteNode } from '@/siting/plan'
import { loadDem, MAX_VIEW_KM, runPlan, viewWidthKm } from '@/siting/run'

/** Node types a site links to: the infrastructure, not companions or sensors. */
const INFRA = new Set(['repeater', 'room'])

/**
 * "Où placer un nœud ?": sites proposed for the view in course (siting/plan),
 * computed on demand from the nodes and links the map holds.
 */
export const useSitingStore = defineStore('siting', () => {
  const mesh = useMeshStore()

  const open = ref(false)
  const state = ref<'idle' | 'running' | 'done' | 'error'>('idle')
  const step = ref('')
  const done = ref(0)
  const error = ref<string | null>(null)
  const result = shallowRef<PlanResult | null>(null)
  /** The view the result was computed for. */
  const resultBBox = ref<BBox | null>(null)
  const selected = ref<string | null>(null)
  /** Antenna height assumed at a proposed site, in m. */
  const antennaM = ref(10)
  /** Elevation tiles that failed to load for the last run, out of how many. */
  const demMissing = ref<{ missing: number; total: number } | null>(null)

  const stale = computed(() => {
    const a = resultBBox.value
    const b = mesh.bbox
    if (!a || !b) return false
    const tol = (a.maxLng - a.minLng) * 0.05
    return (
      Math.abs(a.minLng - b.minLng) > tol ||
      Math.abs(a.maxLng - b.maxLng) > tol ||
      Math.abs(a.minLat - b.minLat) > tol ||
      Math.abs(a.maxLat - b.maxLat) > tol
    )
  })

  /** The view's width, and whether it is too wide to compute (MAX_VIEW_KM). */
  const viewKm = computed(() => (mesh.bbox ? viewWidthKm(mesh.bbox) : 0))
  const tooWide = computed(() => viewKm.value > MAX_VIEW_KM)

  let cancel: (() => void) | null = null

  /** The repeaters and room servers in view, plus those at the far end of a link in view. */
  function graphInput(): { nodes: SiteNode[]; edges: [string, string][] } {
    const nodes = new Map<string, SiteNode>()
    for (const f of mesh.visibleNodes.features) {
      const p = f.properties
      if (!INFRA.has(p.nodeType) || p.listenOnly) continue
      const [lon, lat] = (f.geometry as unknown as { coordinates: [number, number] }).coordinates
      nodes.set(p.key, { key: p.key, name: p.name, lon, lat })
    }
    const edges: [string, string][] = []
    for (const f of mesh.visibleLinks.features) {
      const p = f.properties
      if (!INFRA.has(p.aType ?? '') || !INFRA.has(p.bType ?? '')) continue
      const c = (f.geometry as unknown as { coordinates: [number, number][] }).coordinates
      const ends: [string, string, [number, number] | undefined][] = [
        [p.aKey, p.aName, c[0]],
        [p.bKey, p.bName, c[c.length - 1]],
      ]
      for (const [key, name, at] of ends) if (!nodes.has(key) && at) nodes.set(key, { key, name, lon: at[0], lat: at[1] })
      edges.push([p.aKey, p.bKey])
    }
    return { nodes: [...nodes.values()], edges }
  }

  async function run() {
    const bbox = mesh.bbox
    if (!bbox || state.value === 'running' || tooWide.value) return
    state.value = 'running'
    error.value = null
    selected.value = null
    step.value = 'Relief de la zone'
    done.value = 0
    try {
      const { missing, total, ...dem } = await loadDem(bbox)
      if (!dem.tiles.length) throw new Error('relief indisponible (tuiles Terrain Tiles injoignables)')
      demMissing.value = missing ? { missing, total } : null
      const usable = mesh.snrThresholds[1] ?? -5
      const job = runPlan(
        { bbox: { ...bbox }, ...graphInput(), dem, siteAntennaM: antennaM.value, nodeAntennaM: 10, usableSnrDb: usable },
        (s, d) => {
          step.value = s
          done.value = d
        },
      )
      cancel = job.cancel
      result.value = await job.promise
      resultBBox.value = { ...bbox }
      state.value = 'done'
    } catch (e) {
      if (state.value !== 'running') return // cancelled
      state.value = 'error'
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      cancel = null
    }
  }

  function clear() {
    cancel?.()
    cancel = null
    state.value = 'idle'
    result.value = null
    resultBBox.value = null
    selected.value = null
    error.value = null
  }

  return { open, state, step, done, error, result, selected, antennaM, demMissing, stale, viewKm, tooWide, run, clear }
})
