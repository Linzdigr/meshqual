<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { Frame, HistoryBucket, LinkProperties } from '@/api/types'
import FrameTable from './FrameTable.vue'
import SnrSparkline from './SnrSparkline.vue'
import { formatDuration } from '@/utils/duration'

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
const panelEl = ref<HTMLElement | null>(null)

let measureCtx: CanvasRenderingContext2D | null = null

/** Width of `text` in the frame table's direction font (11px, see FrameTable .dir). */
function textWidth(text: string, el: HTMLElement): number {
  measureCtx ??= document.createElement('canvas').getContext('2d')
  if (!measureCtx) return 0
  measureCtx.font = `11px ${getComputedStyle(el).fontFamily}`
  return measureCtx.measureText(text).width
}

/**
 * Widens the panel so the "Sens" column shows both node names in full. It only
 * grows: a width the user dragged wider is kept. Run on opening a link (from the
 * header, before any frame is in) and again once frames arrive, since their
 * scrollbars eat into the column.
 */
async function fitToContent() {
  await nextTick()
  const el = panelEl.value
  const l = props.link
  if (!el || !l) return
  let overflow = 0
  const cells = el.querySelectorAll<HTMLElement>('.frames .dir')
  if (cells.length > 0) {
    for (const c of cells) overflow = Math.max(overflow, c.scrollWidth - c.clientWidth)
  } else {
    const th = el.querySelector<HTMLElement>('.frames thead th:last-child')
    if (!th) return
    const pad = getComputedStyle(th)
    const available = th.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight)
    const a = l.aName || l.aKey.slice(0, 6)
    const b = l.bName || l.bKey.slice(0, 6)
    overflow = textWidth(`${a} → ${b}`, th) - available
  }
  if (overflow > 0) width.value = clampWidth(width.value + overflow + 4)
}

watch(
  () => props.link?.linkId,
  (id) => {
    if (!id) return
    width.value = loadWidth()
    void fitToContent()
  },
  { immediate: true },
)

watch(
  () => props.frames.length > 0,
  (has) => {
    if (has) void fitToContent()
  },
)

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
  void fitToContent()
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
  /** A direction tile: the label is drawn as "from → to" in the node colours. */
  from?: 'a' | 'b'
}

const basisHint: Record<string, string> = {
  both: 'le plus faible des deux sens',
  oneWay: 'un seul sens mesuré',
  few: 'peu de mesures : médiane globale',
}

function directionTile(
  from: 'a' | 'b',
  label: string,
  median?: number,
  p10?: number,
  count?: number,
): Tile {
  if (median === undefined || !count) return { label, from, value: '—', hint: 'non mesuré' }
  return {
    label,
    from,
    value: median.toFixed(1),
    unit: 'dB',
    hint: `p10 ${p10?.toFixed(1) ?? '—'} · ${count} mesure${count > 1 ? 's' : ''}`,
  }
}

const names = computed(() => ({
  a: props.link ? props.link.aName || props.link.aKey.slice(0, 8) : '',
  b: props.link ? props.link.bName || props.link.bKey.slice(0, 8) : '',
}))

/**
 * One tile per direction of transmission, kept in their own titled group: side
 * by side with the summary tiles they read like an A/B table, which they are not.
 */
const directionTiles = computed<Tile[]>(() => {
  const l = props.link
  if (!l || l.kind === 'topology') return []
  const a = l.aName || l.aKey.slice(0, 8)
  const b = l.bName || l.bKey.slice(0, 8)
  return [
    directionTile('a', `${a} → ${b}`, l.snrMedianAB, l.snrP10AB, l.snrCountAB),
    directionTile('b', `${b} → ${a}`, l.snrMedianBA, l.snrP10BA, l.snrCountBA),
  ]
})

const tiles = computed(() => {
  const l = props.link
  if (!l) return []
  const out: Tile[] = []

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
  <aside v-if="link" ref="panelEl" class="panel" :style="{ '--panel-width': `${width}px` }">
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
    <!-- The visible grip. Width only: the panel's height follows the map. -->
    <div
      class="grip"
      aria-hidden="true"
      title="Glisser pour redimensionner, double-clic pour revenir à la largeur par défaut"
      @pointerdown.prevent="startResize"
      @dblclick="resetWidth"
    >
      <svg viewBox="0 0 12 12" width="12" height="12">
        <path d="M1 1 L11 11 M1 5 L7 11 M1 9 L3 11" />
      </svg>
    </div>
    <div class="body">
      <header>
        <div class="titles">
          <h2>
            <span class="node node-a">{{ names.a }}</span>
            <span class="arrow" aria-hidden="true">↔</span>
            <span class="node node-b">{{ names.b }}</span>
          </h2>
          <p class="sub">
            <span class="kind" :class="link.kind">{{ kindLabel[link.kind] ?? link.kind }}</span>
            <span class="mono">vu il y a {{ formatDuration(link.ageSec) }}</span>
            <span v-if="live" class="live">
              <i aria-hidden="true" />flux actif
            </span>
          </p>
        </div>
        <button class="close" type="button" aria-label="Fermer le panneau" @click="emit('close')">
          ✕
        </button>
      </header>

      <section v-if="directionTiles.length" class="directions">
        <h3>SNR par sens de transmission</h3>
        <div class="tiles">
          <div
            v-for="t in directionTiles"
            :key="t.label"
            class="tile direction"
            :class="`from-${t.from}`"
          >
            <span class="t-label" :title="t.label">
              <span :class="`node-${t.from}`">{{ t.from === 'a' ? names.a : names.b }}</span>
              →
              <span :class="`node-${t.from === 'a' ? 'b' : 'a'}`">{{ t.from === 'a' ? names.b : names.a }}</span>
            </span>
            <span class="t-value mono">
              {{ t.value }}<small v-if="t.unit"> {{ t.unit }}</small>
            </span>
            <span v-if="t.hint" class="t-hint">{{ t.hint }}</span>
          </div>
        </div>
      </section>

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
        <span class="node-a" :title="link.aKey">{{ link.aKey.slice(0, 16) }}…</span>
        <span class="node-b" :title="link.bKey">{{ link.bKey.slice(0, 16) }}…</span>
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

.grip {
  position: absolute;
  left: 0;
  bottom: 0;
  z-index: 2;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-top-right-radius: 6px;
  border-bottom-left-radius: var(--radius);
  background: var(--surface-2);
  color: var(--text-secondary);
  cursor: ew-resize;
  touch-action: none;
}

/* Mirrored: the grip sits in the bottom-left corner, the panel grows leftwards. */
.grip svg {
  transform: scaleX(-1);
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linecap: round;
}

.grip:hover {
  background: var(--accent);
  color: #fff;
}

.node-a {
  color: var(--node-a);
}

.node-b {
  color: var(--node-b);
}

@media (max-width: 760px) {
  .panel {
    width: auto;
  }

  .resize,
  .grip {
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
  border-color: var(--kind-measured);
  color: var(--kind-measured);
}

.kind.trace {
  border-color: var(--kind-trace);
  color: var(--kind-trace);
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

/* Each direction tile is edged in its sender's colour: it reads as one arrow. */
.tile.direction {
  border-left: 3px solid var(--border);
}

.tile.direction.from-a {
  border-left-color: var(--node-a);
}

.tile.direction.from-b {
  border-left-color: var(--node-b);
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
