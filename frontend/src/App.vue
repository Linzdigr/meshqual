<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useMeshStore } from '@/stores/mesh'
import { useLiveStream } from '@/composables/useLiveStream'
import { useTheme } from '@/composables/useTheme'
import { api } from '@/api/client'
import type { BBox, LinkKind } from '@/api/types'
import MeshMap from '@/components/MeshMap.vue'
import SnrLegend from '@/components/SnrLegend.vue'
import LinkPanel from '@/components/LinkPanel.vue'
import NodePanel from '@/components/NodePanel.vue'
import StatusBar from '@/components/StatusBar.vue'
import LayersControl from '@/components/LayersControl.vue'
import type { AltitudeRange } from '@/map/elevation'

const store = useMeshStore()
const { mode, dark, cycle } = useTheme()

const selectedRef = computed(() => store.selectedLinkId)

const mainEl = ref<HTMLElement | null>(null)
const legendEl = ref<HTMLElement | null>(null)
const panelEl = ref<HTMLElement | null>(null)
const meshMap = ref<InstanceType<typeof MeshMap> | null>(null)

/**
 * Shareable links. The URL carries the selection (?link=A:B or ?node=KEY) so
 * the address bar, and the share button that copies it, always point at what is
 * on screen. replaceState: selecting things should not pile up history entries.
 */
const initial = (() => {
  const p = new URLSearchParams(window.location.search)
  return { link: p.get('link'), node: p.get('node') }
})()
const deepLink = initial.link !== null || initial.node !== null

// A notice the map refresh does not clear (it resets store.error on success).
const notice = ref<string | null>(null)
let noticeTimer: number | undefined
function showNotice(text: string) {
  notice.value = text
  window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => (notice.value = null), 12_000)
}

watch(
  () => [store.selectedLinkId, store.selectedNodeKey] as const,
  ([link, node]) => {
    if (link || node) notice.value = null
    const url = new URL(window.location.href)
    url.searchParams.delete('link')
    url.searchParams.delete('node')
    if (link) url.searchParams.set('link', link)
    else if (node) url.searchParams.set('node', node)
    window.history.replaceState(window.history.state, '', url)
  },
)

/**
 * Opens the selection from the URL. A node frames itself once its detail loads
 * (see the nodeDetail watcher). A link may lie outside the current map view, so
 * its ends are fetched and framed first; the next refresh then brings the link
 * itself, and its panel, into view.
 */
async function openDeepLink() {
  if (initial.node) {
    void store.selectNode(initial.node.toUpperCase())
    return
  }
  if (!initial.link) return
  const id = initial.link.toUpperCase()
  try {
    const d = await api.link(id)
    const points: [number, number][] = []
    for (const n of [d.a, d.b]) {
      if (n.Latitude !== null && n.Longitude !== null) points.push([n.Longitude, n.Latitude])
    }
    void store.selectLink(id)
    await nextTick()
    if (points.length > 0) meshMap.value?.focusPoints(points, focusPadding())
    lastFocusAt = Date.now()
  } catch {
    showNotice("Ce lien partagé n'a pas été entendu récemment : il n'est plus sur la carte.")
  }
}

// Narrow screens fold the legend under its mode switch. It folds again when a
// link or node is opened, so the panel docked at the bottom has the room.
const legendOpen = ref(false)

/** What the altitude colours currently span, for the scale beside the map controls. */
const altitudeRange = ref<AltitudeRange | null>(null)
watch(
  () => store.selectedLinkId ?? store.selectedNodeKey,
  (sel) => {
    if (sel) legendOpen.value = false
  },
)

/**
 * Map area hidden by the overlays, as fitBounds padding. On a narrow screen the
 * panel is docked at the bottom across the full width, so it pads the bottom.
 */
function focusPadding() {
  const gap = 32
  // Node labels hang below their point: leave them room at the top and bottom.
  const pad = { top: gap + 24, right: gap, bottom: gap + 24, left: gap }
  const m = mainEl.value?.getBoundingClientRect()
  if (!m) return pad
  const l = legendEl.value?.getBoundingClientRect()
  if (l && l.width > 0) {
    // Narrow screens put the legend across the top instead of down the left.
    if (l.width > m.width * 0.7) pad.top = l.bottom - m.top + gap
    else pad.left = l.right - m.left + gap
  }
  const r = panelEl.value?.getBoundingClientRect()
  if (r && r.width > 0) {
    if (r.width > m.width * 0.7) pad.bottom = m.bottom - r.top + gap
    else pad.right = m.right - r.left + gap
  } else if (store.selectedLinkId || store.selectedNodeKey) {
    // The panel is about to open (a shared link): keep its future place clear.
    if (m.width <= 760) pad.bottom = m.height * 0.52 + gap
    else pad.right = Math.min(460, m.width * 0.4) + gap
  }
  return pad
}

// Frame the selected link once its panel is laid out, so the padding is real.
watch(
  () => store.selectedLinkId,
  async (id) => {
    if (!id) return
    lastFocusAt = Date.now()
    await nextTick()
    requestAnimationFrame(() => meshMap.value?.focus(id, focusPadding()))
  },
)

/**
 * The link panel settles its width after opening (it widens to fit node names,
 * and with a shared link it only appears once the link is loaded). Reframe when
 * that happens shortly after a selection, so the link is not left under it. A
 * later resize is the user's doing and leaves the view alone.
 */
let lastFocusAt = 0
const REFOCUS_WINDOW_MS = 4000
const panelObserver = new ResizeObserver(() => {
  const id = store.selectedLinkId
  if (!id || Date.now() - lastFocusAt > REFOCUS_WINDOW_MS) return
  meshMap.value?.focus(id, focusPadding())
})
watch(panelEl, (el, old) => {
  if (old) panelObserver.unobserve(old)
  if (el) panelObserver.observe(el)
})

// Frame a selected node with its neighbours once their positions are known.
watch(
  () => store.nodeDetail,
  async (d) => {
    if (!d) return
    const points: [number, number][] = []
    for (const n of [d.node, ...d.neighbors]) {
      if (n.lat !== null && n.lon !== null) points.push([n.lon, n.lat])
    }
    if (points.length === 0) return
    await nextTick()
    requestAnimationFrame(() => meshMap.value?.focusPoints(points, focusPadding()))
  },
)

/**
 * Refresh policy.
 *
 * The server pushes a coalesced `links:changed` over SSE; we debounce it into at
 * most one fetch per push interval. A plain 10s poll was the brief, but it is
 * both laggier and more wasteful than this: nothing is fetched while the mesh is
 * quiet, and a burst still costs one request. The interval timer below is only a
 * fallback for a dead stream.
 */
let debounce: number | undefined
let fallback: number | undefined

function scheduleRefresh() {
  if (debounce !== undefined) return
  debounce = window.setTimeout(() => {
    debounce = undefined
    void store.refreshLinks()
  }, Math.max(400, store.pushIntervalMs / 2))
}

const stream = useLiveStream({
  linkId: selectedRef,
  onLinksChanged: () => scheduleRefresh(),
  onFrame: (linkId, frame) => store.pushFrame(linkId, frame),
})

const counts = computed(() => {
  const out: Record<LinkKind, number> = { measured: 0, trace: 0, topology: 0 }
  for (const f of store.links.features) out[f.properties.kind] = (out[f.properties.kind] ?? 0) + 1
  return out
})

function onMoveEnd(b: BBox) {
  store.setBBox(b)
  void store.refreshLinks()
}

function onToggleKind(kind: LinkKind) {
  store.toggleKind(kind)
  void store.refreshLinks()
}

onMounted(async () => {
  await store.loadConfig()
  await Promise.all([store.refreshLinks(), store.refreshHealth()])
  await openDeepLink()

  // Health every 15s: it drives the source chips, not the map.
  fallback = window.setInterval(() => {
    void store.refreshHealth()
    // If the stream is down, fall back to polling so the map does not go stale.
    if (!stream.connected.value) void store.refreshLinks()
  }, 15_000)
})

onUnmounted(() => {
  if (debounce !== undefined) clearTimeout(debounce)
  if (fallback !== undefined) clearInterval(fallback)
  window.clearTimeout(noticeTimer)
  panelObserver.disconnect()
})

watch(
  () => store.selectedLinkId,
  (id) => {
    if (id) void store.loadFrames(id)
  },
)
</script>

<template>
  <div class="app">
    <StatusBar
      :meta="store.meta"
      :health="store.health"
      :stream-connected="stream.connected.value"
      :loading="store.loading"
      :error="store.error ?? notice"
      :theme-mode="mode"
      @cycle-theme="cycle"
    />

    <main ref="mainEl">
      <MeshMap
        ref="meshMap"
        :links="store.links"
        :nodes="store.nodes"
        :selected-link-id="store.selectedLinkId"
        :selected-node-key="store.selectedNodeKey"
        :thresholds="store.snrThresholds"
        :dark="dark"
        :mode="store.viewMode"
        :asym-only="store.asymOnly"
        :asym-threshold="store.asymmetryThresholdDb"
        :palette="store.palette"
        :altitude="store.altitude"
        :no-auto-fit="deepLink"
        @moveend="onMoveEnd"
        @select="(id) => store.selectLink(id)"
        @select-node="(key) => store.selectNode(key)"
        @altitude-range="(r) => (altitudeRange = r)"
      />

      <LayersControl
        :altitude="store.altitude"
        :range="altitudeRange"
        @toggle-altitude="store.altitude = !store.altitude"
      />

      <div ref="legendEl" class="overlay left">
        <SnrLegend
          :thresholds="store.snrThresholds"
          :kinds="store.kinds"
          :counts="counts"
          :mode="store.viewMode"
          :asym-only="store.asymOnly"
          :asym-count="store.asymmetricCount"
          :asym-threshold="store.asymmetryThresholdDb"
          :palette="store.palette"
          :functional-count="store.functionalCount"
          :one-byte-hash-count="store.oneByteHashCount"
          v-model:open="legendOpen"
          @toggle="onToggleKind"
          @set-mode="(m) => (store.viewMode = m)"
          @toggle-asym-only="store.asymOnly = !store.asymOnly"
          @set-palette="(p) => (store.palette = p)"
        />
      </div>

      <div v-if="store.selectedNodeKey" ref="panelEl" class="overlay right">
        <NodePanel
          :node-key="store.selectedNodeKey"
          :detail="store.nodeDetail"
          :thresholds="store.snrThresholds"
          @close="store.selectNode(null)"
          @open-link="(id) => store.selectLink(id)"
        />
      </div>

      <div v-else-if="store.selectedLink" ref="panelEl" class="overlay right">
        <LinkPanel
          :link="store.selectedLink"
          :frames="store.frames"
          :history="store.history"
          :thresholds="store.snrThresholds"
          :asym-threshold="store.asymmetryThresholdDb"
          :profile="store.profile"
          @close="store.selectLink(null)"
        />
      </div>
    </main>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
}

main {
  position: relative;
  flex: 1;
  min-height: 0;
}

.overlay {
  position: absolute;
  top: 12px;
  z-index: 2;
  max-height: calc(100% - 24px);
  pointer-events: auto;
}

.left {
  left: 12px;
}

.right {
  right: 56px;
  display: flex;
}

@media (max-width: 760px) {
  .overlay {
    top: auto;
    bottom: 12px;
    left: 12px;
    right: 12px;
    max-height: 52%;
  }

  .right {
    right: 12px;
  }

  /* The legend stays up top, beside the zoom buttons; the panel docks below. */
  .left {
    top: 12px;
    bottom: auto;
    right: 56px;
    max-height: 45%;
  }
}
</style>
