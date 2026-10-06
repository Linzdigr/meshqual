<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import type { BBox, FeatureCollection, LinkProperties, NodeProperties } from '@/api/types'
import { useMapLibre, type Padding } from '@/composables/useMapLibre'
import type { AltitudeRange } from '@/map/elevation'
import { loadView, saveView } from '@/map/savedView'
import type { NodeIssue } from '@/map/nodeIssues'
import type { ViewMode } from '@/map/lanes'
import type { SnrPalette } from '@/styles/scale'

const props = defineProps<{
  links: FeatureCollection<LinkProperties>
  nodes: FeatureCollection<NodeProperties>
  selectedLinkId: string | null
  selectedNodeKey: string | null
  thresholds: number[]
  dark: boolean
  mode: ViewMode
  asymOnly: boolean
  asymThreshold: number
  palette: SnrPalette
  measureRetentionSec: number
  issues: NodeIssue[]
  altitude: boolean
  /** Nodes picked for a trace, in order, and the companion it starts from. */
  tracePath: string[]
  traceStart: string | null
  /** Skip framing all nodes on first load: a shared link frames its own target. */
  noAutoFit?: boolean
}>()

const emit = defineEmits<{
  moveend: [BBox]
  select: [string | null]
  selectNode: [string | null]
  altitudeRange: [AltitudeRange | null]
}>()

const container = ref<HTMLElement | null>(null)
const thresholdsRef = ref(props.thresholds)
const darkRef = ref(props.dark)
const modeRef = ref(props.mode)
const asymOnlyRef = ref(props.asymOnly)
const asymThresholdRef = ref(props.asymThreshold)
const paletteRef = ref(props.palette)
const altitudeRef = ref(props.altitude)
const retentionRef = ref(props.measureRetentionSec)
const issuesRef = ref(props.issues)

// The view the user left on their last visit, if any: it wins over framing
// the whole mesh, so a reload lands where they were.
const savedView = loadView()

const map = useMapLibre({
  container,
  center: savedView?.center,
  zoom: savedView?.zoom,
  onViewChange: saveView,
  dark: darkRef,
  thresholds: thresholdsRef,
  mode: modeRef,
  asymOnly: asymOnlyRef,
  asymThreshold: asymThresholdRef,
  palette: paletteRef,
  altitude: altitudeRef,
  measureRetentionSec: retentionRef,
  issues: issuesRef,
  onAltitudeRange: (r) => emit('altitudeRange', r),
  onMoveEnd: (b) => emit('moveend', b),
  onSelectLink: (id) => emit('select', id),
  onSelectNode: (key) => emit('selectNode', key),
})

onMounted(() => map.mount())

/**
 * Frame the mesh once, on the first data that arrives. The default view is a
 * guess; the actual nodes are not. Only the first time -- refitting on every
 * refresh would fight the user's own panning.
 */
let autoFitted = false
function autoFit(fc: FeatureCollection<NodeProperties>) {
  if (props.noAutoFit || savedView || autoFitted || fc.features.length < 2) return
  let minLng = Infinity
  let minLat = Infinity
  let maxLng = -Infinity
  let maxLat = -Infinity
  for (const f of fc.features) {
    const c = (f.geometry as { coordinates?: [number, number] }).coordinates
    // A bad position would make fitBounds throw and leave the view unframed.
    if (!c || Math.abs(c[1]) > 90 || Math.abs(c[0]) > 180) continue
    minLng = Math.min(minLng, c[0])
    maxLng = Math.max(maxLng, c[0])
    minLat = Math.min(minLat, c[1])
    maxLat = Math.max(maxLat, c[1])
  }
  if (!Number.isFinite(minLng)) return
  autoFitted = true
  map.fitTo({ minLng, minLat, maxLng, maxLat })
}

watch(() => props.links, (fc) => map.setLinks(fc))
watch(
  () => props.nodes,
  (fc) => {
    map.setNodes(fc)
    autoFit(fc)
  },
)
watch(
  () => props.selectedLinkId,
  (id) => {
    map.highlight(id)
    map.markOnLink(null, null) // the chart that placed it is gone
  },
)
watch(() => props.selectedNodeKey, (key) => map.highlightNode(key))
watch(
  () => props.issues,
  (i) => {
    issuesRef.value = i
    map.applyView()
  },
)
watch(
  () => props.measureRetentionSec,
  (sec) => {
    retentionRef.value = sec
    map.applyFocus()
  },
)
watch(
  () => props.altitude,
  (on) => {
    altitudeRef.value = on
    map.applyAltitude()
  },
)

defineExpose({
  /** Frames a link inside the map area left free by the overlays (padding in px). */
  focus: (linkId: string, padding: Padding) => map.focusLink(linkId, padding),
  /** Frames [lng, lat] points the same way: a node and its neighbours. */
  focusPoints: (points: [number, number][], padding: Padding) => map.focusPoints(points, padding),
  /** Puts a point a fraction of the way along a link, or clears it with null. */
  markOnLink: (linkId: string | null, fraction: number | null) => map.markOnLink(linkId, fraction),
  /** Fades all but the nodes a trace visits (in order) and the links between them; null lifts it. */
  setTraceFocus: (visits: string[] | null) => map.setTraceFocus(visits),
  /** Labels the links of a returned trace with its SNR readings; [] clears them. */
  setTraceLabels: (hops: { from: string; to: string; snr?: number }[]) => map.setTraceLabels(hops),
  /** Plays trace legs with the live-packet animation. */
  animateHops: (hops: { from: string; to: string; snr?: number }[]) => map.animateHops(hops),
})

// Redrawn when nodes refresh too: the path is drawn from their positions.
watch(
  () => [props.tracePath, props.traceStart, props.nodes] as const,
  ([keys, start]) => map.setTracePath(start, keys),
)

watch(
  () => [props.mode, props.asymOnly] as const,
  ([mode, only]) => {
    modeRef.value = mode
    asymOnlyRef.value = only
    map.applyView()
  },
)

// The threshold decides which lanes are emphasized, which is baked into the data.
watch(
  () => props.asymThreshold,
  (t) => {
    asymThresholdRef.value = t
    map.setLinks(props.links)
  },
)

watch(
  () => [props.dark, props.thresholds, props.palette] as const,
  ([dark, thresholds, palette]) => {
    darkRef.value = dark
    thresholdsRef.value = thresholds
    paletteRef.value = palette
    map.retheme()
    map.setLinks(props.links)
    map.setNodes(props.nodes)
    map.highlight(props.selectedLinkId)
    map.highlightNode(props.selectedNodeKey)
  },
)
</script>

<template>
  <div ref="container" class="map" />
</template>

<style scoped>
.map {
  position: absolute;
  inset: 0;
  background: var(--surface-0);
}
</style>
