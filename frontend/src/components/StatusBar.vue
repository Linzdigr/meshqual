<script setup lang="ts">
import { computed } from 'vue'
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
  <div class="bar">
    <div class="group">
      <span class="brand">meshqual</span>
      <span v-if="health" class="mono dim">v{{ health.version }}</span>
    </div>

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

      <button type="button" class="theme" :title="`Thème : ${themeMode}`" @click="emit('cycleTheme')">
        <i class="pi pi-palette" aria-hidden="true" />
        <span>{{ themeMode }}</span>
      </button>
    </div>

    <p v-if="error" class="err" role="alert">
      <i class="pi pi-exclamation-triangle" aria-hidden="true" /> {{ error }}
    </p>
  </div>
</template>

<style scoped>
.bar {
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
