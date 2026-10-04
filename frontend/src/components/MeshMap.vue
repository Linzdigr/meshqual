<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import type { BBox, FeatureCollection, LinkProperties, NodeProperties } from '@/api/types'
import { useMapLibre, type Padding } from '@/composables/useMapLibre'
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
  /** Skip framing all nodes on first load: a shared link frames its own target. */
  noAutoFit?: boolean
}>()

const emit = defineEmits<{
  moveend: [BBox]
  select: [string | null]
  selectNode: [string | null]
}>()

const container = ref<HTMLElement | null>(null)
const thresholdsRef = ref(props.thresholds)
const darkRef = ref(props.dark)
const modeRef = ref(props.mode)
const asymOnlyRef = ref(props.asymOnly)
const asymThresholdRef = ref(props.asymThreshold)
const paletteRef = ref(props.palette)

const map = useMapLibre({
  container,
  dark: darkRef,
  thresholds: thresholdsRef,
  mode: modeRef,
  asymOnly: asymOnlyRef,
  asymThreshold: asymThresholdRef,
  palette: paletteRef,
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
  if (props.noAutoFit || autoFitted || fc.features.length < 2) return
  let minLng = Infinity
  let minLat = Infinity
  let maxLng = -Infinity
  let maxLat = -Infinity
  for (const f of fc.features) {
    const c = (f.geometry as { coordinates?: [number, number] }).coordinates
    if (!c) continue
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
watch(() => props.selectedLinkId, (id) => map.highlight(id))
watch(() => props.selectedNodeKey, (key) => map.highlightNode(key))

defineExpose({
  /** Frames a link inside the map area left free by the overlays (padding in px). */
  focus: (linkId: string, padding: Padding) => map.focusLink(linkId, padding),
  /** Frames [lng, lat] points the same way: a node and its neighbours. */
  focusPoints: (points: [number, number][], padding: Padding) => map.focusPoints(points, padding),
})

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
