<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import type { BBox, FeatureCollection, LinkProperties, NodeProperties } from '@/api/types'
import { useMapLibre } from '@/composables/useMapLibre'
import type { ViewMode } from '@/map/lanes'

const props = defineProps<{
  links: FeatureCollection<LinkProperties>
  nodes: FeatureCollection<NodeProperties>
  selectedLinkId: string | null
  thresholds: number[]
  dark: boolean
  mode: ViewMode
  asymOnly: boolean
  asymThreshold: number
}>()

const emit = defineEmits<{
  moveend: [BBox]
  select: [string | null]
}>()

const container = ref<HTMLElement | null>(null)
const thresholdsRef = ref(props.thresholds)
const darkRef = ref(props.dark)
const modeRef = ref(props.mode)
const asymOnlyRef = ref(props.asymOnly)
const asymThresholdRef = ref(props.asymThreshold)

const map = useMapLibre({
  container,
  dark: darkRef,
  thresholds: thresholdsRef,
  mode: modeRef,
  asymOnly: asymOnlyRef,
  asymThreshold: asymThresholdRef,
  onMoveEnd: (b) => emit('moveend', b),
  onSelectLink: (id) => emit('select', id),
})

onMounted(() => map.mount())

/**
 * Frame the mesh once, on the first data that arrives. The default view is a
 * guess; the actual nodes are not. Only the first time -- refitting on every
 * refresh would fight the user's own panning.
 */
let autoFitted = false
function autoFit(fc: FeatureCollection<NodeProperties>) {
  if (autoFitted || fc.features.length < 2) return
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
  () => [props.dark, props.thresholds] as const,
  ([dark, thresholds]) => {
    darkRef.value = dark
    thresholdsRef.value = thresholds
    map.retheme()
    map.setLinks(props.links)
    map.setNodes(props.nodes)
    map.highlight(props.selectedLinkId)
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
