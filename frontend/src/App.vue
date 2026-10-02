<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { useMeshStore } from '@/stores/mesh'
import { useLiveStream } from '@/composables/useLiveStream'
import { useTheme } from '@/composables/useTheme'
import type { BBox, LinkKind } from '@/api/types'
import MeshMap from '@/components/MeshMap.vue'
import SnrLegend from '@/components/SnrLegend.vue'
import LinkPanel from '@/components/LinkPanel.vue'
import StatusBar from '@/components/StatusBar.vue'

const store = useMeshStore()
const { mode, dark, cycle } = useTheme()

const selectedRef = computed(() => store.selectedLinkId)

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
      :error="store.error"
      :theme-mode="mode"
      @cycle-theme="cycle"
    />

    <main>
      <MeshMap
        :links="store.links"
        :nodes="store.nodes"
        :selected-link-id="store.selectedLinkId"
        :thresholds="store.snrThresholds"
        :dark="dark"
        :mode="store.viewMode"
        :asym-only="store.asymOnly"
        :asym-threshold="store.asymmetryThresholdDb"
        @moveend="onMoveEnd"
        @select="(id) => store.selectLink(id)"
      />

      <div class="overlay left">
        <SnrLegend
          :thresholds="store.snrThresholds"
          :kinds="store.kinds"
          :counts="counts"
          :mode="store.viewMode"
          :asym-only="store.asymOnly"
          :asym-count="store.asymmetricCount"
          :asym-threshold="store.asymmetryThresholdDb"
          @toggle="onToggleKind"
          @set-mode="(m) => (store.viewMode = m)"
          @toggle-asym-only="store.asymOnly = !store.asymOnly"
        />
      </div>

      <div v-if="store.selectedLink" class="overlay right">
        <LinkPanel
          :link="store.selectedLink"
          :frames="store.frames"
          :history="store.history"
          :thresholds="store.snrThresholds"
          :asym-threshold="store.asymmetryThresholdDb"
          :live="stream.connected.value"
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

  .left {
    display: none;
  }
}
</style>
