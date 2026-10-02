<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Frame, HistoryBucket, LinkProperties } from '@/api/types'
import FrameTable from './FrameTable.vue'
import SnrSparkline from './SnrSparkline.vue'

const props = defineProps<{
  link: LinkProperties | null
  frames: Frame[]
  history: HistoryBucket[]
  thresholds: number[]
  asymThreshold: number
  live: boolean
}>()

const emit = defineEmits<{ close: [] }>()

/**
 * Panel width, dragged from the left edge (the panel is anchored to the right).
 * Remembered per browser; storage can be unavailable, so every access is guarded.
 */
const WIDTH_KEY = 'meshqual.panelWidth'
const DEFAULT_WIDTH = 340
const MIN_WIDTH = 300

function maxWidth(): number {
  return Math.max(MIN_WIDTH, Math.min(960, window.innerWidth - 96))
}

function clampWidth(w: number): number {
  return Math.round(Math.min(maxWidth(), Math.max(MIN_WIDTH, w)))
}

function loadWidth(): number {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY))
    if (v > 0) return clampWidth(v)
  } catch {}
  return DEFAULT_WIDTH
}

const width = ref(loadWidth())

function saveWidth() {
  try {
    localStorage.setItem(WIDTH_KEY, String(width.value))
  } catch {}
}

function startResize(e: PointerEvent) {
  const handle = e.currentTarget as HTMLElement
  const startX = e.clientX
  const startWidth = width.value
  handle.setPointerCapture(e.pointerId)
  const move = (ev: PointerEvent) => {
    width.value = clampWidth(startWidth + startX - ev.clientX)
  }
  const end = () => {
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', end)
    handle.removeEventListener('pointercancel', end)
    saveWidth()
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', end)
  handle.addEventListener('pointercancel', end)
}

function nudgeWidth(delta: number) {
  width.value = clampWidth(width.value + delta)
  saveWidth()
}

function resetWidth() {
  width.value = clampWidth(DEFAULT_WIDTH)
  saveWidth()
}

const kindLabel: Record<string, string> = {
  measured: 'Mesuré',
  trace: 'Trace',
  topology: 'Topologique',
}

interface Tile {
  label: string
  value: string
  unit?: string
  hint?: string
  /** Beyond a threshold: flagged with an icon as well as the text, never colour alone. */
  alert?: boolean
}

const basisHint: Record<string, string> = {
  both: 'le plus faible des deux sens',
  oneWay: 'un seul sens mesuré',
  few: 'peu de mesures : médiane globale',
}

function directionTile(label: string, median?: number, p10?: number, count?: number): Tile {
  if (median === undefined || !count) return { label, value: '—', hint: 'non mesuré' }
  return {
    label,
    value: median.toFixed(1),
    unit: 'dB',
    hint: `p10 ${p10?.toFixed(1) ?? '—'} · ${count} mesure${count > 1 ? 's' : ''}`,
  }
}

const tiles = computed(() => {
  const l = props.link
  if (!l) return []
  const out: Tile[] = []
  const a = l.aName || l.aKey.slice(0, 8)
  const b = l.bName || l.bKey.slice(0, 8)

  // Directions first, side by side: they are what the other tiles summarise.
  if (l.kind !== 'topology') {
    out.push(directionTile(`${a} → ${b}`, l.snrMedianAB, l.snrP10AB, l.snrCountAB))
    out.push(directionTile(`${b} → ${a}`, l.snrMedianBA, l.snrP10BA, l.snrCountBA))
  }

  if (l.snrQuality !== undefined) {
    out.push({
      label: 'Qualité',
      value: l.snrQuality.toFixed(1),
      unit: 'dB',
      hint: basisHint[l.snrBasis ?? 'few'],
    })
  } else {
    out.push({
      label: 'SNR',
      value: '—',
      hint: 'aucune mesure pour ce type de lien',
    })
  }

  if (l.snrDelta !== undefined) {
    const gap = Math.abs(l.snrDelta)
    const alert = gap >= props.asymThreshold
    out.push({
      label: 'Asymétrie',
      value: gap.toFixed(1),
      unit: 'dB',
      hint: `${alert ? 'au-delà' : 'en dessous'} du seuil de ${props.asymThreshold} dB`,
      alert,
    })
  }

  out.push({ label: 'Trames', value: String(l.samples), hint: `${l.forward} / ${l.backward} par sens` })
  out.push({ label: 'Distance', value: l.distKm.toFixed(1), unit: 'km' })
  return out
})
</script>

<template>
  <aside v-if="link" class="panel" :style="{ '--panel-width': `${width}px` }">
    <div
      class="resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Redimensionner le panneau"
      :aria-valuenow="width"
      tabindex="0"
      title="Glisser pour redimensionner, double-clic pour revenir à la largeur par défaut"
      @pointerdown.prevent="startResize"
      @dblclick="resetWidth"
      @keydown.left.prevent="nudgeWidth(24)"
      @keydown.right.prevent="nudgeWidth(-24)"
    />
    <div class="body">
      <header>
        <div class="titles">
          <h2>
            <span class="node">{{ link.aName || link.aKey.slice(0, 8) }}</span>
            <span class="arrow" aria-hidden="true">↔</span>
            <span class="node">{{ link.bName || link.bKey.slice(0, 8) }}</span>
          </h2>
          <p class="sub">
            <span class="kind" :class="link.kind">{{ kindLabel[link.kind] ?? link.kind }}</span>
            <span class="mono">vu il y a {{ link.ageSec }} s</span>
            <span v-if="live" class="live">
              <i aria-hidden="true" />flux actif
            </span>
          </p>
        </div>
        <button class="close" type="button" aria-label="Fermer le panneau" @click="emit('close')">
          ✕
        </button>
      </header>

      <div class="tiles">
        <div v-for="t in tiles" :key="t.label" class="tile" :class="{ alert: t.alert }">
          <span class="t-label" :title="t.label">{{ t.label }}</span>
          <span class="t-value mono">
            <i v-if="t.alert" class="pi pi-exclamation-triangle" aria-hidden="true" />
            {{ t.value }}<small v-if="t.unit"> {{ t.unit }}</small>
          </span>
          <span v-if="t.hint" class="t-hint">{{ t.hint }}</span>
        </div>
      </div>

      <p v-if="link.kind === 'topology'" class="warn">
        Ce lien vient de sauts adjacents dans un chemin observé. Il prouve que les deux relais
        s'entendent, mais aucune valeur de SNR n'existe pour ce saut : seuls le dernier saut vers un
        observateur et les paquets TRACE sont mesurés.
      </p>

      <section>
        <SnrSparkline :buckets="history" />
      </section>

      <section>
        <h3>{{ frames.length }} dernières trames</h3>
        <FrameTable
          :frames="frames"
          :thresholds="thresholds"
          :a-name="link.aName || link.aKey.slice(0, 6)"
          :b-name="link.bName || link.bKey.slice(0, 6)"
        />
      </section>

      <footer class="keys mono">
        <span :title="link.aKey">{{ link.aKey.slice(0, 16) }}…</span>
        <span :title="link.bKey">{{ link.bKey.slice(0, 16) }}…</span>
      </footer>
    </div>
  </aside>
</template>

<style scoped>
.panel {
  position: relative;
  display: flex;
  width: var(--panel-width, 340px);
  max-height: 100%;
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

/* The scroll lives here, not on .panel, so the resize handle stays put. */
.body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 14px;
}

.resize {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -4px;
  width: 8px;
  cursor: ew-resize;
  touch-action: none;
  z-index: 1;
}

.resize::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 3px;
  width: 2px;
  height: 32px;
  transform: translateY(-50%);
  border-radius: 1px;
  background: var(--border);
}

.resize:hover::after,
.resize:focus-visible::after {
  background: var(--accent);
}

@media (max-width: 760px) {
  .panel {
    width: auto;
  }

  .resize {
    display: none;
  }
}

header {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.titles {
  flex: 1;
  min-width: 0;
}

h2 {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 5px;
}

.node {
  overflow-wrap: anywhere;
}

.arrow {
  color: var(--text-muted);
}

.sub {
  margin: 4px 0 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 10.5px;
  color: var(--text-muted);
}

.kind {
  padding: 1px 6px;
  border-radius: 3px;
  border: 1px solid var(--border);
  font-size: 10px;
  color: var(--text-secondary);
}

.kind.measured {
  border-color: var(--snr-2);
  color: var(--snr-2);
}

.kind.trace {
  border-color: var(--snr-1);
  color: var(--snr-1);
}

.live {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--status-good);
}

.live i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--status-good);
}

.close {
  background: none;
  border: 0;
  color: var(--text-muted);
  font-size: 13px;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 3px;
}

.close:hover {
  background: var(--surface-2);
  color: var(--text-primary);
}

.tiles {
  display: grid;
  /* minmax(0, …): long node names must truncate, not widen the grid. */
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 2px;
}

.tile {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 7px 9px;
  background: var(--surface-2);
  border-radius: 4px;
}

.t-label {
  font-size: 9.5px;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: var(--text-secondary);
  /* Direction tiles carry node names, which can be long. */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tile.alert .pi {
  font-size: 13px;
  color: var(--status-warning);
}

.t-value {
  font-size: 19px;
  font-weight: 600;
  line-height: 1.15;
}

.t-value small {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-secondary);
}

.t-hint {
  font-size: 9.5px;
  color: var(--text-muted);
}

.warn {
  margin: 0;
  padding: 8px 10px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--text-secondary);
  background: var(--surface-2);
  border-left: 2px solid var(--no-data);
  border-radius: 3px;
}

section h3 {
  margin: 0 0 6px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.keys {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 9.5px;
  color: var(--text-muted);
  border-top: 1px solid var(--border);
  padding-top: 8px;
}
</style>
