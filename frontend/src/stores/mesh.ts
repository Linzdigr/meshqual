import { computed, ref, shallowRef, watch } from 'vue'
import { defineStore } from 'pinia'
import { api, type LinksQuery } from '@/api/client'
import type {
  BBox,
  CollectionMeta,
  FeatureCollection,
  Frame,
  Health,
  HistoryBucket,
  LinkKind,
  LinkProperties,
  NodeDetail,
  NodeProperties,
  ServerConfig,
} from '@/api/types'
import { DEFAULT_SNR_THRESHOLDS, type SnrPalette } from '@/styles/scale'
import { isAsymmetric, type ViewMode } from '@/map/lanes'

const EMPTY = <P,>(): FeatureCollection<P> => ({ type: 'FeatureCollection', features: [] })

const VIEW_KEY = 'meshqual.view'

interface ViewPrefs {
  mode: ViewMode
  asymOnly: boolean
  palette: SnrPalette
}

/** View preferences are per browser; storage may be unavailable, so it is optional. */
function loadView(): ViewPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') as Partial<Record<keyof ViewPrefs, unknown>>
    return {
      mode: v.mode === 'asymmetry' || v.mode === 'functional' ? v.mode : 'quality',
      asymOnly: v.asymOnly === true,
      palette: v.palette === 'traffic' ? 'traffic' : 'blue',
    }
  } catch {
    return { mode: 'quality', asymOnly: false, palette: 'blue' }
  }
}

export const useMeshStore = defineStore('mesh', () => {
  // shallowRef: these collections are replaced wholesale and handed straight to
  // MapLibre. Deep reactivity over tens of thousands of coordinates would cost
  // far more than it buys.
  const links = shallowRef<FeatureCollection<LinkProperties>>(EMPTY())
  const nodes = shallowRef<FeatureCollection<NodeProperties>>(EMPTY())
  const meta = ref<CollectionMeta | null>(null)

  const config = ref<ServerConfig | null>(null)
  const health = ref<Health | null>(null)

  const selectedLinkId = ref<string | null>(null)
  // A node and a link are never selected together: the panel shows one or the other.
  const selectedNodeKey = ref<string | null>(null)
  const nodeDetail = ref<NodeDetail | null>(null)
  const frames = ref<Frame[]>([])
  const history = ref<HistoryBucket[]>([])

  const bbox = ref<BBox | null>(null)
  const kinds = ref<LinkKind[]>(['measured', 'trace', 'topology'])
  const minSamples = ref(1)

  const savedView = loadView()
  const viewMode = ref<ViewMode>(savedView.mode)
  const asymOnly = ref(savedView.asymOnly)
  const palette = ref<SnrPalette>(savedView.palette)
  watch([viewMode, asymOnly, palette], ([mode, only, pal]) => {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify({ mode, asymOnly: only, palette: pal }))
    } catch {}
  })
  // The CSS ramp variables (legend, frame table) switch on this attribute; the
  // map gets the same palette through its own props.
  watch(
    palette,
    (p) => {
      if (p === 'traffic') document.documentElement.setAttribute('data-palette', 'traffic')
      else document.documentElement.removeAttribute('data-palette')
    },
    { immediate: true },
  )

  const loading = ref(false)
  const error = ref<string | null>(null)
  const lastRefresh = ref<Date | null>(null)

  const snrThresholds = computed<number[]>(
    () => config.value?.snrThresholds ?? [...DEFAULT_SNR_THRESHOLDS],
  )
  const framesMax = computed(() => config.value?.framesMax ?? 20)
  const pushIntervalMs = computed(() => config.value?.pushIntervalMs ?? 2000)
  const asymmetryThresholdDb = computed(() => config.value?.asymmetryThresholdDb ?? 6)
  /** Links shown by the "Fonctionnel" view: weaker direction at or above the usable threshold. */
  const functionalCount = computed(() => {
    const t = snrThresholds.value[1] ?? -5
    return links.value.features.filter((f) => (f.properties.snrQuality ?? -Infinity) >= t).length
  })
  const asymmetricCount = computed(
    () => links.value.features.filter((f) => isAsymmetric(f.properties, asymmetryThresholdDb.value)).length,
  )

  const selectedLink = computed(() => {
    if (!selectedLinkId.value) return null
    return (
      links.value.features.find((f) => f.properties.linkId === selectedLinkId.value)?.properties ??
      null
    )
  })

  /** Links the server could not draw because an endpoint never advertised a position. */
  const undrawable = computed(() => meta.value?.withoutPosition ?? 0)

  let linksAbort: AbortController | null = null

  async function loadConfig() {
    try {
      config.value = await api.config()
    } catch (e) {
      error.value = describe(e)
    }
  }

  async function refreshLinks() {
    linksAbort?.abort()
    const ac = new AbortController()
    linksAbort = ac
    loading.value = true
    try {
      const q: LinksQuery = {
        bbox: bbox.value,
        kinds: kinds.value,
        minSamples: minSamples.value,
      }
      const [l, n] = await Promise.all([
        api.links(q, ac.signal),
        api.nodes(bbox.value, ac.signal),
      ])
      links.value = { ...l, features: l.features ?? [] }
      nodes.value = { ...n, features: n.features ?? [] }
      meta.value = l.meta ?? null
      lastRefresh.value = new Date()
      error.value = null
    } catch (e) {
      if (!isAbort(e)) error.value = describe(e)
    } finally {
      if (linksAbort === ac) loading.value = false
    }
  }

  async function refreshHealth() {
    try {
      health.value = await api.health()
    } catch {
      // Health is informational; a failure here must not blank the map.
    }
  }

  async function selectNode(key: string | null) {
    selectedNodeKey.value = key
    nodeDetail.value = null
    if (key) {
      selectedLinkId.value = null
      frames.value = []
      history.value = []
      await loadNode(key)
    }
  }

  async function loadNode(key: string) {
    try {
      const d = await api.node(key)
      if (selectedNodeKey.value === key) nodeDetail.value = d
    } catch (e) {
      if (!isAbort(e)) error.value = describe(e)
    }
  }

  async function selectLink(linkId: string | null) {
    selectedLinkId.value = linkId
    if (linkId) {
      selectedNodeKey.value = null
      nodeDetail.value = null
    }
    frames.value = []
    history.value = []
    if (!linkId) return
    await Promise.all([loadFrames(linkId), loadHistory(linkId)])
  }

  async function loadFrames(linkId: string) {
    try {
      const res = await api.frames(linkId, framesMax.value)
      if (selectedLinkId.value !== linkId) return
      frames.value = res.frames ?? []
    } catch (e) {
      if (!isAbort(e)) error.value = describe(e)
    }
  }

  async function loadHistory(linkId: string, window = '24h', bucket = '1h') {
    try {
      const res = await api.history(linkId, window, bucket)
      if (selectedLinkId.value !== linkId) return
      history.value = res.buckets ?? []
    } catch {
      // No database configured means no history; the live panel still works.
      history.value = []
    }
  }

  /** Prepend a frame pushed over SSE, keeping the list bounded and newest-first. */
  function pushFrame(linkId: string, frame: Frame) {
    if (linkId !== selectedLinkId.value) return
    if (frames.value.some((f) => f.wireHash === frame.wireHash && f.at === frame.at)) return
    frames.value = [frame, ...frames.value].slice(0, framesMax.value)
  }

  function setBBox(b: BBox) {
    bbox.value = b
  }

  function toggleKind(kind: LinkKind) {
    kinds.value = kinds.value.includes(kind)
      ? kinds.value.filter((k) => k !== kind)
      : [...kinds.value, kind]
  }

  return {
    links,
    nodes,
    meta,
    config,
    health,
    selectedLinkId,
    selectedNodeKey,
    nodeDetail,
    selectedLink,
    frames,
    history,
    bbox,
    kinds,
    minSamples,
    viewMode,
    asymOnly,
    palette,
    asymmetryThresholdDb,
    asymmetricCount,
    functionalCount,
    loading,
    error,
    lastRefresh,
    snrThresholds,
    framesMax,
    pushIntervalMs,
    undrawable,
    loadConfig,
    refreshLinks,
    refreshHealth,
    selectLink,
    selectNode,
    loadNode,
    loadFrames,
    loadHistory,
    pushFrame,
    setBBox,
    toggleKind,
  }
})

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError'
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
