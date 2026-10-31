<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { CollectionMeta, Health } from '@/api/types'

const props = defineProps<{
  meta: CollectionMeta | null
  health: Health | null
  streamConnected: boolean
  loading: boolean
  error: string | null
  themeMode: string
}>()

const emit = defineEmits<{ cycleTheme: [] }>()

const pct = (v: number) => `${(v * 100).toFixed(1)} %`

const sources = computed(() => props.health?.sources ?? [])

/**
 * Narrow screens keep one row (name, search, theme) and fold the figures and
 * chips behind one status button, coloured like the worst of them.
 */
const detailsOpen = ref(false)
const overall = computed(() => {
  if (sources.value.some((s) => !s.connected)) return 'critical'
  if (!props.streamConnected) return 'warning'
  return 'good'
})
const overallLabel = computed(
  () =>
    ({ critical: 'une source est déconnectée', warning: 'flux temps réel coupé', good: 'tout est connecté' })[
      overall.value
    ],
)
const barEl = ref<HTMLElement | null>(null)
function onPointerDown(e: PointerEvent) {
  if (detailsOpen.value && !barEl.value?.contains(e.target as Node)) detailsOpen.value = false
}
onMounted(() => document.addEventListener('pointerdown', onPointerDown))
onUnmounted(() => document.removeEventListener('pointerdown', onPointerDown))

/**
 * Attribution quality is a headline, not a footnote. On a young mesh most hops
 * resolve to nothing, and a map that hides that reads as authoritative when it
 * is mostly guesswork.
 */
const attribution = computed(() => {
  const m = props.meta
  if (!m) return null
  const bad = m.unresolvedShare + m.ambiguousShare
  return {
    unresolved: pct(m.unresolvedShare),
    ambiguous: pct(m.ambiguousShare),
    level: bad > 0.4 ? 'critical' : bad > 0.15 ? 'warning' : 'good',
  }
})
</script>

<template>
  <div ref="barEl" class="bar">
    <div class="group">
      <span class="brand">meshqual</span>
      <span v-if="health" class="mono dim version">{{ /^\d/.test(health.version) ? `v${health.version}` : health.version }}</span>
    </div>

    <slot />

    <!-- Inline on wide screens; a drop-down under the bar on narrow ones. -->
    <div id="status-details" class="details" :class="{ open: detailsOpen }">
      <div class="group">
        <span class="stat" :class="{ busy: loading }">
          <span class="mono n">{{ meta?.returned ?? 0 }}</span>
          <span class="l">liens affichés</span>
        </span>
        <span v-if="meta?.truncated" class="chip warning" title="Augmentez le zoom pour tout voir">
          tronqué sur {{ meta.total }}
        </span>
        <span
          v-if="meta && meta.withoutPosition > 0"
          class="chip"
          :title="`${meta.withoutPosition} liens dont un relais n'a jamais annoncé de position : impossibles à tracer`"
        >
          <span class="mono">{{ meta.withoutPosition }}</span> sans position
        </span>
        <span class="stat">
          <span class="mono n">{{ health?.nodes ?? 0 }}</span>
          <span class="l">nœuds connus</span>
        </span>
      </div>

      <div v-if="attribution" class="group">
        <!-- Status colour never travels alone: icon plus label plus the number. -->
        <span class="chip" :class="attribution.level">
          <i class="pi" :class="attribution.level === 'good' ? 'pi-check-circle' : 'pi-exclamation-triangle'" aria-hidden="true" />
          <span>attribution</span>
          <span class="mono" :title="'hashs non résolus'">{{ attribution.unresolved }}</span>
          <span class="sep" aria-hidden="true">/</span>
          <span class="mono" :title="'hashs ambigus (collision de préfixe)'">{{ attribution.ambiguous }}</span>
        </span>
      </div>

      <div class="group right">
        <span v-for="s in sources" :key="s.id" class="chip" :class="s.connected ? 'good' : 'critical'">
          <i class="pi" :class="s.connected ? 'pi-link' : 'pi-times-circle'" aria-hidden="true" />
          <span>{{ s.id }}</span>
          <span class="mono">{{ s.received }}</span>
          <span v-if="s.dropped > 0" class="mono drop" :title="`${s.dropped} messages délestés`">
            −{{ s.dropped }}
          </span>
        </span>

        <span class="chip" :class="streamConnected ? 'good' : 'warning'">
          <i class="pi" :class="streamConnected ? 'pi-bolt' : 'pi-pause'" aria-hidden="true" />
          <span>{{ streamConnected ? 'SSE' : 'hors flux' }}</span>
        </span>
      </div>
    </div>

    <div class="group end">
      <button
        type="button"
        class="status-toggle"
        :class="overall"
        :aria-expanded="detailsOpen"
        aria-controls="status-details"
        :title="`État : ${overallLabel}`"
        @click="detailsOpen = !detailsOpen"
      >
        <span class="dot" aria-hidden="true" />
        <i class="pi" :class="detailsOpen ? 'pi-chevron-up' : 'pi-chevron-down'" aria-hidden="true" />
        <span class="sr-only">État et statistiques</span>
      </button>
      <button type="button" class="theme" :title="`Thème : ${themeMode}`" @click="emit('cycleTheme')">
        <i class="pi pi-palette" aria-hidden="true" />
        <span class="theme-name">{{ themeMode }}</span>
      </button>
    </div>

    <p v-if="error" class="err" role="alert">
      <i class="pi pi-exclamation-triangle" aria-hidden="true" /> {{ error }}
    </p>
  </div>
</template>

<style scoped>
.bar {
  position: relative;
  z-index: 10;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
  padding: 7px 12px;
  background: var(--surface-1);
  border-bottom: 1px solid var(--border);
  font-size: 11.5px;
}

.group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.right {
  margin-left: auto;
}

.brand {
  font-weight: 600;
  letter-spacing: -0.01em;
}

.dim {
  color: var(--text-muted);
  font-size: 10px;
}

.stat {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
}

.stat.busy {
  opacity: 0.6;
}

.n {
  font-size: 14px;
  font-weight: 600;
}

.l {
  color: var(--text-secondary);
  font-size: 10.5px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border: 1px solid var(--border);
  border-radius: 10px;
  font-size: 10.5px;
  color: var(--text-secondary);
}

.chip .pi {
  font-size: 9px;
}

.chip.good {
  border-color: color-mix(in srgb, var(--status-good) 45%, var(--border));
  color: var(--status-good);
}

.chip.warning {
  border-color: color-mix(in srgb, var(--status-warning) 45%, var(--border));
  color: var(--text-secondary);
}

.chip.critical {
  border-color: color-mix(in srgb, var(--status-critical) 45%, var(--border));
  color: var(--status-critical);
}

.sep {
  color: var(--text-muted);
}

.drop {
  color: var(--status-critical);
}

.theme {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  background: none;
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--text-secondary);
  font: inherit;
  font-size: 10.5px;
  cursor: pointer;
}

.theme:hover {
  background: var(--surface-2);
  color: var(--text-primary);
}

.details {
  display: contents;
}

.status-toggle {
  display: none;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

@media (max-width: 760px) {
  .bar {
    flex-wrap: nowrap;
    gap: 8px;
    padding: 6px 10px;
  }

  .version,
  .theme-name {
    display: none;
  }

  .details {
    display: none;
  }

  .details.open {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 12px 12px;
    background: var(--surface-1);
    border-bottom: 1px solid var(--border);
    box-shadow: 0 6px 16px rgb(0 0 0 / 0.15);
  }

  .details .group {
    flex-wrap: wrap;
  }

  .details .right {
    margin-left: 0;
  }

  .status-toggle {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 7px;
    background: none;
    border: 1px solid var(--border);
    border-radius: 10px;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .status-toggle .pi {
    font-size: 9px;
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--status-good);
  }

  .status-toggle.warning .dot {
    background: var(--status-warning);
  }

  .status-toggle.critical .dot {
    background: var(--status-critical);
  }

  .theme {
    padding: 4px 7px;
  }

  .err {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    margin: 0;
    padding: 6px 12px;
    background: var(--surface-1);
    border-bottom: 1px solid var(--border);
  }
}

.err {
  flex: 1 0 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 2px 0 0;
  font-size: 11px;
  color: var(--status-critical);
}
</style>
