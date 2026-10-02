<script setup lang="ts">
import { computed } from 'vue'
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

function fmt(at: string): string {
  return new Date(at).toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}
</script>

<template>
  <figure v-if="model" class="spark">
    <figcaption>SNR moyen sur 24 h <span class="mono">({{ model.lo }} à {{ model.hi }} dB)</span></figcaption>
    <svg
      :width="width"
      :height="height"
      :viewBox="`0 0 ${width} ${height}`"
      role="img"
      :aria-label="`SNR moyen sur 24 heures, de ${model.lo} à ${model.hi} dB`"
    >
      <polygon :points="model.band" class="band" />
      <polyline :points="model.line" class="line" />
      <!-- Hover target per bucket, wider than the mark itself. -->
      <g>
        <circle
          v-for="p in model.points"
          :key="p.at"
          :cx="p.x"
          :cy="p.y"
          r="5"
          class="hit"
        >
          <title>{{ fmt(p.at) }} — {{ p.value.toFixed(1) }} dB</title>
        </circle>
      </g>
    </svg>
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

svg {
  display: block;
  overflow: visible;
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

.hit {
  fill: transparent;
  cursor: crosshair;
}

.hit:hover {
  fill: var(--accent);
  fill-opacity: 0.9;
  stroke: var(--surface-1);
  stroke-width: 2;
}

.empty {
  margin: 0;
  font-size: 11px;
  color: var(--text-muted);
}
</style>
