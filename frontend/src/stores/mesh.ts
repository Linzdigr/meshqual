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
  LinkProfile,
  LinkProperties,
  NodeDetail,
  NodeProperties,
  ServerConfig,
} from '@/api/types'
import { DEFAULT_SNR_THRESHOLDS, type SnrPalette } from '@/styles/scale'
import { isAsymmetric, isFunctional, type ViewMode } from '@/map/lanes'
import { NODE_ISSUES, nodeIssues, type NodeIssue } from '@/map/nodeIssues'

const EMPTY = <P,>(): FeatureCollection<P> => ({ type: 'FeatureCollection', features: [] })

const VIEW_KEY = 'meshqual.view'

interface ViewPrefs {
  mode: ViewMode
  asymOnly: boolean
  palette: SnrPalette
  altitude: boolean
  /** Node issues the ⚠ flags; the legend switches each off. */
  issues: NodeIssue[]
}

/** View preferences are per browser; storage may be unavailable, so it is optional. */
function loadView(): ViewPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') as Partial<Record<keyof ViewPrefs, unknown>>
    return {
      mode: v.mode === 'asymmetry' || v.mode === 'functional' ? v.mode : 'quality',
      asymOnly: v.asymOnly === true,
      palette: v.palette === 'traffic' ? 'traffic' : 'blue',
      altitude: v.altitude === true,
      issues: Array.isArray(v.issues)
        ? NODE_ISSUES.filter((i) => (v.issues as unknown[]).includes(i))
        : [...NODE_ISSUES],
    }
  } catch {
    return { mode: 'quality', asymOnly: false, palette: 'blue', altitude: false, issues: [...NODE_ISSUES] }
  }
}

const ANTENNA_KEY = 'meshqual.antennas'

function loadAntennas(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(ANTENNA_KEY) ?? '{}') as Record<string, unknown>
    const out: Record<string, number> = {}
    for (const [k, m] of Object.entries(v)) if (typeof m === 'number' && m >= 0 && m <= 300) out[k] = m
    return out
  } catch {
    return {}
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
  /**
   * Line of sight of the selected link, fetched as soon as it is selected so
   * the panel's section is ready when unfolded. 'error' covers a disabled
   * feature or an unreachable elevation service.
   */
  const profile = ref<{ state: 'loading' | 'ready' | 'error'; data?: LinkProfile } | null>(null)

  const bbox = ref<BBox | null>(null)
  const kinds = ref<LinkKind[]>(['measured', 'trace', 'topology'])
  const minSamples = ref(1)

  const savedView = loadView()
  const viewMode = ref<ViewMode>(savedView.mode)
  const asymOnly = ref(savedView.asymOnly)
  const palette = ref<SnrPalette>(savedView.palette)
  const altitude = ref(savedView.altitude)
  const issues = ref<NodeIssue[]>(savedView.issues)
  watch([viewMode, asymOnly, palette, altitude, issues], ([mode, only, pal, alt, iss]) => {
    try {
      localStorage.setItem(
        VIEW_KEY,
        JSON.stringify({ mode, asymOnly: only, palette: pal, altitude: alt, issues: iss }),
      )
    } catch {}
  })
  function toggleIssue(i: NodeIssue) {
    issues.value = issues.value.includes(i) ? issues.value.filter((x) => x !== i) : [...issues.value, i]
  }
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
  const measureRetentionSec = computed(() => config.value?.measureRetentionSec ?? 14 * 86_400)
  /** Links shown by the "Fonctionnel" view: weaker direction at or above the usable threshold. */
  const functionalCount = computed(
    () => links.value.features.filter((f) => isFunctional(f.properties, snrThresholds.value)).length,
  )
  /** Nodes in view per configuration issue (flagged ⚠ on the map). */
  const issueCounts = computed(() => {
    const c: Record<NodeIssue, number> = { hash1: 0, noRegion: 0 }
    for (const f of nodes.value.features) for (const i of nodeIssues(f.properties)) c[i]++
    return c
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

  /**
   * Antenna heights the user gave, per node key, in metres above ground. Kept
   * per browser: masts do not move, and the server only knows a default.
   */
  const antennas = ref<Record<string, number>>(loadAntennas())
  let profileSeq = 0
  let antennaTimer = 0

  async function loadProfile(linkId: string) {
    const seq = ++profileSeq
    // A height change keeps the chart up while the new one computes.
    if (profile.value?.state !== 'ready') profile.value = { state: 'loading' }
    const [a, b] = linkId.split(':')
    try {
      const data = await api.profile(linkId, { antA: antennas.value[a!], antB: antennas.value[b!] })
      if (seq === profileSeq && selectedLinkId.value === linkId) profile.value = { state: 'ready', data }
    } catch {
      if (seq === profileSeq && selectedLinkId.value === linkId) profile.value = { state: 'error' }
    }
  }

  /** Sets a node's antenna height (null: back to the default) and redraws the profile. */
  function setAntenna(key: string, metres: number | null) {
    const next = { ...antennas.value }
    if (metres === null || !Number.isFinite(metres)) delete next[key]
    else next[key] = Math.max(0, Math.min(300, metres))
    antennas.value = next
    try {
      localStorage.setItem(ANTENNA_KEY, JSON.stringify(next))
    } catch {}
    const id = selectedLinkId.value
    if (!id || !id.split(':').includes(key)) return
    // Typing 1, 12, 120 should not send three requests.
    window.clearTimeout(antennaTimer)
    antennaTimer = window.setTimeout(() => void loadProfile(id), 350)
  }

  async function selectLink(linkId: string | null) {
    selectedLinkId.value = linkId
    profile.value = null
    if (linkId) void loadProfile(linkId)
    if (linkId) {
      selectedNodeKey.value = null
      nodeDetail.value = null
    }
    frames.value = []
    history.value = []
    if (!linkId) return
    // A link whose last measurement predates the traffic window would show an
    // empty sparkline over 24 h: widen it to the whole retention period.
    const age = links.value.features.find((f) => f.properties.linkId === linkId)?.properties.measureAgeSec
    const wide = age !== undefined && age > 86_400
    await Promise.all([
      loadFrames(linkId),
      wide ? loadHistory(linkId, `${measureRetentionSec.value}s`, '12h') : loadHistory(linkId),
    ])
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
    profile,
    antennas,
    setAntenna,
    bbox,
    kinds,
    minSamples,
    viewMode,
    asymOnly,
    palette,
    altitude,
    asymmetryThresholdDb,
    measureRetentionSec,
    asymmetricCount,
    functionalCount,
    issueCounts,
    issues,
    toggleIssue,
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
