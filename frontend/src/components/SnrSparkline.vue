<script setup lang="ts">
import { computed, ref } from 'vue'
import type { HistoryBucket } from '@/api/types'

const props = withDefaults(
  defineProps<{
    buckets: HistoryBucket[]
    width?: number
    height?: number
  }>(),
  { width: 258, height: 44 },
)

interface Point {
  x: number
  y: number
  at: string
  value: number
  min: number
  max: number
  samples: number
}

const PAD = 3

/**
 * One series, so no legend box: the caption names it. Min/max band plus the mean
 * line, because an average SNR alone hides exactly the deep fades that matter.
 */
const model = computed(() => {
  const pts = (props.buckets ?? []).filter((b) => b.snrAvg !== null)
  if (pts.length < 2) return null

  const values = pts.flatMap((b) => [b.snrAvg!, b.snrMin ?? b.snrAvg!, b.snrMax ?? b.snrAvg!])
  let lo = Math.min(...values)
  let hi = Math.max(...values)
  if (hi - lo < 2) {
    const mid = (hi + lo) / 2
    lo = mid - 1
    hi = mid + 1
  }

  const w = props.width - PAD * 2
  const h = props.height - PAD * 2
  const x = (i: number) => PAD + (i / (pts.length - 1)) * w
  const y = (v: number) => PAD + h - ((v - lo) / (hi - lo)) * h

  const mean: Point[] = pts.map((b, i) => ({
    x: x(i),
    y: y(b.snrAvg!),
    at: b.bucket,
    value: b.snrAvg!,
    min: b.snrMin ?? b.snrAvg!,
    max: b.snrMax ?? b.snrAvg!,
    samples: b.snrSamples,
  }))

  const upper = pts.map((b, i) => `${x(i)},${y(b.snrMax ?? b.snrAvg!)}`)
  const lower = pts
    .map((b, i) => `${x(i)},${y(b.snrMin ?? b.snrAvg!)}`)
    .reverse()

  return {
    line: mean.map((p) => `${p.x},${p.y}`).join(' '),
    band: `${upper.join(' ')} ${lower.join(' ')}`,
    points: mean,
    lo: Math.round(lo),
    hi: Math.round(hi),
  }
})

/**
 * Hover reads the nearest bucket to the pointer anywhere over the chart, not
 * only on a 5px mark: the guide line and the label then show which hour it is.
 */
const hover = ref<number | null>(null)
const svgEl = ref<SVGSVGElement | null>(null)

const active = computed(() => (hover.value === null ? null : (model.value?.points[hover.value] ?? null)))

function onPointer(e: PointerEvent) {
  const m = model.value
  const el = svgEl.value
  if (!m || !el) return
  const rect = el.getBoundingClientRect()
  const x = ((e.clientX - rect.left) / rect.width) * props.width
  let best = 0
  for (let i = 1; i < m.points.length; i++) {
    if (Math.abs(m.points[i]!.x - x) < Math.abs(m.points[best]!.x - x)) best = i
  }
  hover.value = best
}

function onKey(e: KeyboardEvent) {
  const m = model.value
  if (!m) return
  const last = m.points.length - 1
  if (e.key === 'ArrowLeft') hover.value = Math.max(0, (hover.value ?? last + 1) - 1)
  else if (e.key === 'ArrowRight') hover.value = Math.min(last, (hover.value ?? -1) + 1)
  else if (e.key === 'Escape') hover.value = null
  else return
  e.preventDefault()
}

/** The label sits beside the point, flipped to the left in the right half. */
const labelStyle = computed(() => {
  const p = active.value
  if (!p) return {}
  const left = p.x > props.width / 2
  return left
    ? { right: `${props.width - p.x + 8}px`, top: '0px' }
    : { left: `${p.x + 8}px`, top: '0px' }
})

function fmt(at: string): string {
  return new Date(at).toLocaleString('fr-FR', {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}
</script>

<template>
  <figure v-if="model" class="spark">
    <figcaption>SNR moyen sur 24 h <span class="mono">({{ model.lo }} à {{ model.hi }} dB)</span></figcaption>
    <div class="plot" :style="{ width: `${width}px` }">
      <svg
        ref="svgEl"
        :width="width"
        :height="height"
        :viewBox="`0 0 ${width} ${height}`"
        role="img"
        tabindex="0"
        :aria-label="`SNR moyen sur 24 heures, de ${model.lo} à ${model.hi} dB. Flèches gauche et droite pour lire chaque heure.`"
        @pointermove="onPointer"
        @pointerdown="onPointer"
        @pointerleave="hover = null"
        @keydown="onKey"
        @blur="hover = null"
      >
        <polygon :points="model.band" class="band" />
        <polyline :points="model.line" class="line" />
        <template v-if="active">
          <line :x1="active.x" :x2="active.x" :y1="0" :y2="height" class="guide" />
          <circle :cx="active.x" :cy="active.y" r="4" class="dot" />
        </template>
      </svg>
      <div v-if="active" class="label" :style="labelStyle" aria-live="polite">
        <span class="when">{{ fmt(active.at) }}</span>
        <span class="mono value">{{ active.value.toFixed(1) }} dB</span>
        <span class="mono range">{{ active.min.toFixed(1) }} à {{ active.max.toFixed(1) }} dB</span>
        <span class="count">{{ active.samples }} mesure{{ active.samples > 1 ? 's' : '' }}</span>
      </div>
    </div>
  </figure>
  <p v-else class="empty">
    Pas encore d'historique : il faut une base Timescale configurée et au moins deux intervalles
    de mesures.
  </p>
</template>

<style scoped>
.spark {
  margin: 0;
}

figcaption {
  font-size: 10.5px;
  color: var(--text-secondary);
  margin-bottom: 2px;
}

.plot {
  position: relative;
}

svg {
  display: block;
  overflow: visible;
  cursor: crosshair;
  touch-action: none;
}

svg:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 2px;
}

.band {
  fill: var(--accent);
  opacity: 0.16;
}

.line {
  fill: none;
  stroke: var(--accent);
  stroke-width: 2;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.guide {
  stroke: var(--text-muted);
  stroke-width: 1;
  stroke-dasharray: 2 2;
}

.dot {
  fill: var(--accent);
  stroke: var(--surface-1);
  stroke-width: 2;
}

.label {
  position: absolute;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 4px 7px;
  background: var(--surface-0);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 10.5px;
  white-space: nowrap;
  pointer-events: none;
  box-shadow: 0 2px 6px rgb(0 0 0 / 0.15);
}

.when {
  color: var(--text-secondary);
}

.value {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-primary);
}

.range,
.count {
  color: var(--text-muted);
}

.mono {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}

.empty {
  margin: 0;
  font-size: 11px;
  color: var(--text-muted);
}
</style>
