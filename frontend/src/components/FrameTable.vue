<script setup lang="ts">
import { computed } from 'vue'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import type { Frame } from '@/api/types'
import { snrBucketIndex } from '@/styles/scale'
import { payloadFamily, payloadTitle } from '@/styles/payload'

const props = defineProps<{
  frames: Frame[]
  thresholds: number[]
  aName: string
  bName: string
}>()

const ramp = ['var(--snr-1)', 'var(--snr-2)', 'var(--snr-3)', 'var(--snr-4)']

const rows = computed(() =>
  (props.frames ?? []).map((f, i) => ({
    ...f,
    rowKey: `${f.wireHash}-${f.at}-${i}`,
    age: age(f.at),
    // Each end keeps its panel colour (node-a / node-b) whichever way it goes.
    from: f.forward ? { name: props.aName, end: 'a' } : { name: props.bName, end: 'b' },
    to: f.forward ? { name: props.bName, end: 'b' } : { name: props.aName, end: 'a' },
    family: payloadFamily(f.payloadType),
    typeTitle: payloadTitle(f.payloadType),
  })),
)

function age(at: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 1000))
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.round(s / 60)} min`
  return `${Math.round(s / 3600)} h`
}

function clock(at: string): string {
  return new Date(at).toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function snrColorVar(snr: number | null): string {
  if (snr === null) return 'var(--no-data)'
  return ramp[snrBucketIndex(snr, props.thresholds)] ?? ramp[3]!
}
</script>

<template>
  <div class="frames">
    <DataTable
      :value="rows"
      data-key="rowKey"
      size="small"
      scrollable
      scroll-height="240px"
      :pt="{ table: { style: 'min-width: 0; width: 100%; table-layout: fixed' } }"
    >
      <template #empty>
        <span class="empty">Aucune trame retenue pour ce lien.</span>
      </template>

      <Column header="Heure" style="width: 5.5rem">
        <template #body="{ data }">
          <span class="mono">{{ clock(data.at) }}</span>
          <span class="age">{{ data.age }}</span>
        </template>
      </Column>

      <Column header="SNR" style="width: 5rem">
        <template #body="{ data }">
          <span v-if="data.snr !== null" class="snr">
            <!-- The swatch is a secondary cue; the number is the value. -->
            <i class="dot" :style="{ background: snrColorVar(data.snr) }" aria-hidden="true" />
            <span class="mono">{{ data.snr.toFixed(2) }}</span>
          </span>
          <span v-else class="mono none" title="Saut adjacent : aucune mesure n'existe">—</span>
        </template>
      </Column>

      <Column header="RSSI" style="width: 4.25rem">
        <template #body="{ data }">
          <span class="mono">{{ data.rssi ?? '—' }}</span>
        </template>
      </Column>

      <Column header="Type" style="width: 6.5rem">
        <template #body="{ data }">
          <span class="mono tag" :class="data.family" :title="data.typeTitle">{{ data.payloadType }}</span>
        </template>
      </Column>

      <Column header="Sens">
        <template #body="{ data }">
          <span class="dir" :title="`${data.from.name} → ${data.to.name}`">
            <span :class="`node-${data.from.end}`">{{ data.from.name }}</span>
            <span class="arrow" aria-hidden="true"> → </span>
            <span :class="`node-${data.to.end}`">{{ data.to.name }}</span>
          </span>
          <span class="hop mono">saut {{ data.hopIndex + 1 }}/{{ data.hopCount || 1 }}</span>
        </template>
      </Column>
    </DataTable>
  </div>
</template>

<style scoped>
.frames :deep(.p-datatable) {
  font-size: 11.5px;
}

.frames :deep(.p-datatable-thead > tr > th) {
  padding: 4px 6px;
  font-size: 10px;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: var(--text-secondary);
  background: var(--surface-2);
  border-color: var(--border);
}

.frames :deep(.p-datatable-tbody > tr > td) {
  padding: 3px 6px;
  border-color: var(--border);
}

.mono {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}

.age {
  display: block;
  font-size: 9.5px;
  color: var(--text-muted);
}

.snr {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  box-shadow: 0 0 0 1px var(--surface-1);
  flex: 0 0 auto;
}

.none {
  color: var(--text-muted);
}

.tag {
  --family: var(--text-secondary);
  font-size: 10px;
  padding: 1px 4px;
  border: 1px solid color-mix(in srgb, var(--family) 55%, transparent);
  border-radius: 3px;
  background: color-mix(in srgb, var(--family) 12%, transparent);
  color: var(--family);
}

.tag.message {
  --family: var(--pt-message);
}

.tag.request {
  --family: var(--pt-request);
}

.tag.routing {
  --family: var(--pt-routing);
}

.tag.data {
  --family: var(--pt-data);
}

.node-a {
  color: var(--node-a);
}

.node-b {
  color: var(--node-b);
}

.dir .arrow {
  color: var(--text-muted);
}

.dir {
  display: block;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hop {
  display: block;
  font-size: 9.5px;
  color: var(--text-muted);
}

.empty {
  font-size: 11px;
  color: var(--text-muted);
}
</style>
