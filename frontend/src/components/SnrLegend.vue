<script setup lang="ts">
import { computed } from 'vue'
import { snrBuckets } from '@/styles/scale'
import type { LinkKind } from '@/api/types'

const props = defineProps<{
  thresholds: number[]
  kinds: LinkKind[]
  counts: Record<LinkKind, number>
}>()

const emit = defineEmits<{ toggle: [LinkKind] }>()

const ramp = ['var(--snr-1)', 'var(--snr-2)', 'var(--snr-3)', 'var(--snr-4)']

// Strongest first. Each bucket keeps its ramp colour, so the order can change
// without the swatches drifting off the map's colours.
const buckets = computed(() =>
  snrBuckets(props.thresholds)
    .map((b, i) => ({ ...b, color: ramp[i] }))
    .reverse(),
)

const kindRows: { kind: LinkKind; label: string; hint: string }[] = [
  { kind: 'measured', label: 'Mesurés', hint: "SNR relevé par l'observateur sur le dernier saut" },
  { kind: 'trace', label: 'Trace', hint: 'SNR par saut, ajouté par chaque relais (paquets TRACE)' },
  { kind: 'topology', label: 'Topologiques', hint: 'Sauts adjacents : aucune mesure de signal existe' },
]

function active(kind: LinkKind): boolean {
  return props.kinds.includes(kind)
}
</script>

<template>
  <div class="legend">
    <div class="block">
      <h3>SNR médian</h3>
      <!-- The ramp is ordinal, so every step carries its dB range: the colour is
           an ordering, not a readable value. -->
      <ul class="ramp">
        <li v-for="b in buckets" :key="b.label">
          <span class="swatch" :style="{ background: b.color }" aria-hidden="true" />
          <span class="mono range">{{ b.label }}</span>
          <span class="note">{{ b.note }}</span>
        </li>
      </ul>
    </div>

    <div class="block">
      <h3>Type de lien</h3>
      <ul class="kinds">
        <li v-for="row in kindRows" :key="row.kind">
          <button
            type="button"
            :class="{ off: !active(row.kind) }"
            :aria-pressed="active(row.kind)"
            :title="row.hint"
            @click="emit('toggle', row.kind)"
          >
            <span class="mark" :class="row.kind" aria-hidden="true" />
            <span class="label">{{ row.label }}</span>
            <span class="mono count">{{ counts[row.kind] ?? 0 }}</span>
          </button>
        </li>
      </ul>
      <p class="caveat">
        Un lien topologique prouve que les deux relais s'entendent, mais le champ
        <code>path</code> ne transporte que des hashs de routage : aucun SNR n'existe pour ces
        sauts.
      </p>
    </div>
  </div>
</template>

<style scoped>
.legend {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 12px;
  background: color-mix(in srgb, var(--surface-1) 94%, transparent);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  backdrop-filter: blur(6px);
  max-width: 290px;
}

h3 {
  margin: 0 0 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.ramp li {
  display: grid;
  grid-template-columns: 14px auto 1fr;
  align-items: center;
  gap: 8px;
}

.swatch {
  width: 14px;
  height: 10px;
  border-radius: 2px;
  /* A 2px surface ring keeps adjacent swatches from touching. */
  box-shadow: 0 0 0 1px var(--surface-1);
}

.range {
  font-size: 11px;
  color: var(--text-primary);
  white-space: nowrap;
}

.note {
  font-size: 11px;
  color: var(--text-muted);
}

.kinds button {
  display: grid;
  grid-template-columns: 22px 1fr auto;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 3px 4px;
  background: none;
  border: 0;
  border-radius: 4px;
  color: var(--text-primary);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.kinds button:hover {
  background: var(--surface-2);
}

.kinds button.off {
  opacity: 0.4;
}

.mark {
  height: 0;
  border-top-width: 2px;
  border-top-style: solid;
}

.mark.measured {
  border-top-color: var(--snr-2);
  border-top-width: 3px;
}

.mark.trace {
  border-top-color: var(--snr-1);
  border-top-width: 3px;
}

.mark.topology {
  border-top-color: var(--no-data);
  border-top-style: dashed;
}

.count {
  font-size: 11px;
  color: var(--text-muted);
}

.caveat {
  margin: 8px 0 0;
  font-size: 10.5px;
  line-height: 1.4;
  color: var(--text-muted);
}

code {
  font-family: var(--mono);
  font-size: 10px;
}
</style>
