<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import type { LinkProfile } from '@/api/types'

const props = defineProps<{
  state: 'loading' | 'ready' | 'error'
  profile?: LinkProfile
  aName: string
  bName: string
}>()

const emit = defineEmits<{
  /** Pointer position along the link, 0 at A and 1 at B; null when it leaves. */
  hover: [number | null]
  /** A new antenna height for one end, in metres above ground; null resets it. */
  setAntenna: ['a' | 'b', number | null]
}>()

function onHeight(end: 'a' | 'b', e: Event) {
  const raw = (e.target as HTMLInputElement).value
  emit('setAntenna', end, raw === '' ? null : Number(raw))
}

const W = 600
const H = 170
const PAD = { top: 10, bottom: 6 }

const result = computed(() => (props.profile?.available ? props.profile.result : undefined))

/**
 * Terrain (ground plus the earth's bulge) as a filled area, the straight line
 * between the antennas, and the first Fresnel zone as a band around it. The
 * SVG stretches to the panel width; strokes keep their width (non-scaling).
 */
const chart = computed(() => {
  const r = result.value
  if (!r || r.points.length < 2) return null
  const pts = r.points
  const total = pts[pts.length - 1]!.d || 1
  let lo = Infinity
  let hi = -Infinity
  for (const p of pts) {
    lo = Math.min(lo, p.t, p.l - p.f)
    hi = Math.max(hi, p.t, p.l + p.f)
  }
  const span = Math.max(hi - lo, 10)
  lo -= span * 0.05
  hi += span * 0.05
  const x = (d: number) => (d / total) * W
  const y = (m: number) => PAD.top + (1 - (m - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom)

  const terrain = `M0,${H} ` + pts.map((p) => `L${x(p.d)},${y(p.t)}`).join(' ') + ` L${W},${H} Z`
  const upper = pts.map((p) => `${x(p.d)},${y(p.l + p.f)}`)
  const lower = pts.map((p) => `${x(p.d)},${y(p.l - p.f)}`).reverse()
  const first = pts[0]!
  const last = pts[pts.length - 1]!
  return {
    terrain,
    fresnel: `${upper.join(' ')} ${lower.join(' ')}`,
    los: { x1: 0, y1: y(first.l), x2: W, y2: y(last.l) },
    masts: [
      { x: 1, top: y(first.l), ground: y(first.t), end: 'a' },
      { x: W - 1, top: y(last.l), ground: y(last.t), end: 'b' },
    ],
    worst: { x: x(r.worst.d), y: y(r.worst.t) },
    lo: Math.round(lo),
    hi: Math.round(hi),
    x,
    y,
    total,
  }
})

/**
 * The profile sample nearest the pointer. Shown on the chart (guide, marks on
 * the ground and on the line, a readout) and sent up so the map marks the same
 * spot on the link.
 */
const hoverIndex = ref<number | null>(null)

const hovered = computed(() => {
  const c = chart.value
  const r = result.value
  if (!c || !r || hoverIndex.value === null) return null
  const p = r.points[hoverIndex.value]
  if (!p) return null
  return {
    x: c.x(p.d),
    ground: c.y(p.t),
    line: c.y(p.l),
    d: p.d,
    // Height of the direct line above the ground (bulge included).
    margin: Math.round(p.l - p.t),
    side: p.d / c.total > 0.5 ? 'left' : 'right',
    pct: (p.d / c.total) * 100,
  }
})

function onPointer(e: PointerEvent) {
  const c = chart.value
  const r = result.value
  if (!c || !r) return
  const rect = (e.currentTarget as SVGElement).getBoundingClientRect()
  const target = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * c.total
  let best = 0
  for (let i = 1; i < r.points.length; i++) {
    if (Math.abs(r.points[i]!.d - target) < Math.abs(r.points[best]!.d - target)) best = i
  }
  hoverIndex.value = best
  emit('hover', r.points[best]!.d / c.total)
}

function onLeave() {
  hoverIndex.value = null
  emit('hover', null)
}

onUnmounted(() => emit('hover', null))

const verdictLabel: Record<string, string> = {
  clear: 'Dégagé',
  partial: 'Partiellement dégagé',
  blocked: 'Obstrué',
}

const km = (v: number) => `${v.toFixed(2).replace('.', ',')} km`

const summary = computed(() => {
  const r = result.value
  if (!r) return ''
  const pct = Math.round(r.clearance * 100)
  const at = km(r.worst.d)
  if (r.verdict === 'blocked') {
    const over = Math.max(0, r.worst.t - r.worst.l)
    return over > 0
      ? `Le relief dépasse la ligne directe de ${Math.round(over)} m à ${at}.`
      : `La zone de Fresnel est presque entièrement occupée à ${at}.`
  }
  if (r.verdict === 'partial') {
    return `${pct} % de la première zone de Fresnel est libre au point le plus serré (${at}), 60 % sont recommandés.`
  }
  return `La première zone de Fresnel est libre à ${Math.min(pct, 100)} % au point le plus serré (${at}).`
})
</script>

<template>
  <div class="los-body">
    <p v-if="state === 'loading'" class="note">Calcul du profil…</p>
    <p v-else-if="state === 'error'" class="note">
      Profil indisponible : service d'altitude injoignable ou désactivé.
    </p>
    <p v-else-if="profile && !profile.available" class="note">
      {{
        profile.reason === 'no_coverage'
          ? 'Profil indisponible : le relief IGN ne couvre que la France.'
          : 'Lien trop court pour tracer un profil.'
      }}
    </p>

    <template v-else-if="result && chart">
      <p class="summary">
        <span class="verdict" :class="result.verdict">{{ verdictLabel[result.verdict] }}</span>
        {{ summary }}
      </p>
      <figure class="chart">
        <div class="plot">
          <svg
            :viewBox="`0 0 ${W} ${H}`"
            preserveAspectRatio="none"
            role="img"
            :aria-label="`Profil du relief entre ${aName} et ${bName} : ${verdictLabel[result.verdict]}`"
            @pointermove="onPointer"
            @pointerdown="onPointer"
            @pointerleave="onLeave"
          >
            <polygon :points="chart.fresnel" class="fresnel" />
            <path :d="chart.terrain" class="terrain" />
            <line v-bind="chart.los" class="los" />
            <line
              v-for="m in chart.masts"
              :key="m.end"
              :x1="m.x"
              :x2="m.x"
              :y1="m.ground"
              :y2="m.top"
              :class="`mast node-${m.end}`"
            />
            <template v-if="result.verdict !== 'clear'">
              <line :x1="chart.worst.x" :x2="chart.worst.x" :y1="0" :y2="H" class="worst-guide" />
            </template>
            <template v-if="hovered">
              <line :x1="hovered.x" :x2="hovered.x" :y1="0" :y2="H" class="hover-guide" />
              <line :x1="hovered.x" :x2="hovered.x" :y1="hovered.ground" :y2="hovered.line" class="hover-gap" />
            </template>
          </svg>
          <!-- Round marks in HTML: in the stretched SVG a circle would turn oval. -->
          <template v-if="hovered">
            <i class="hover-dot on-line" :style="{ left: `${hovered.pct}%`, top: `${(hovered.line / H) * 100}%` }" />
            <i class="hover-dot on-ground" :style="{ left: `${hovered.pct}%`, top: `${(hovered.ground / H) * 100}%` }" />
            <span class="readout mono" :class="hovered.side" :style="{ left: `${hovered.pct}%` }">
              {{ km(hovered.d) }} ·
              {{
                hovered.margin >= 0
                  ? `ligne ${hovered.margin} m au-dessus du sol`
                  : `sol ${-hovered.margin} m au-dessus de la ligne`
              }}
            </span>
          </template>
        </div>
        <figcaption class="ends">
          <span class="node-a">{{ aName }}</span>
          <span class="mono scale">{{ chart.lo }}–{{ chart.hi }} m · {{ km(result.distKm) }}</span>
          <span class="node-b">{{ bName }}</span>
        </figcaption>
      </figure>
      <ul class="key">
        <li><i class="sw terrain" aria-hidden="true" />relief + courbure terrestre</li>
        <li><i class="sw los" aria-hidden="true" />ligne directe entre antennes</li>
        <li><i class="sw fresnel" aria-hidden="true" />1re zone de Fresnel</li>
      </ul>
      <fieldset class="heights">
        <legend>Hauteur d'antenne au-dessus du sol</legend>
        <label>
          <span class="node-a">{{ aName }}</span>
          <input
            type="number"
            min="0"
            max="300"
            step="1"
            inputmode="numeric"
            :value="profile?.antennaAM ?? profile?.antennaM"
            @input="onHeight('a', $event)"
          />
          m
        </label>
        <label>
          <span class="node-b">{{ bName }}</span>
          <input
            type="number"
            min="0"
            max="300"
            step="1"
            inputmode="numeric"
            :value="profile?.antennaBM ?? profile?.antennaM"
            @input="onHeight('b', $event)"
          />
          m
        </label>
      </fieldset>
      <p class="note">
        Hauteurs mémorisées par nœud dans ce navigateur ({{ profile?.antennaM }} m par défaut ; vider le
        champ y revient). {{ profile?.freqMHz }} MHz, courbure terrestre k = 4/3. Relief IGN (RGE ALTI)
        sans bâtiments ni végétation : la réalité peut être moins favorable.
      </p>
    </template>
  </div>
</template>

<style scoped>
.los-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 8px;
}

.note {
  margin: 0;
  font-size: 10.5px;
  line-height: 1.4;
  color: var(--text-muted);
}

.summary {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
}

/* Verdict colour comes with its word, never alone. */
.verdict {
  margin-right: 6px;
  padding: 1px 6px;
  border: 1px solid currentColor;
  border-radius: 3px;
  font-size: 10.5px;
  font-weight: 600;
}

.verdict.clear {
  color: var(--status-good);
}

.verdict.partial {
  color: var(--status-warning);
}

.verdict.blocked {
  color: var(--status-critical);
}

.chart {
  margin: 0;
}

.plot {
  position: relative;
}

.hover-guide {
  stroke: var(--text-muted);
  stroke-width: 1;
  stroke-dasharray: 2 3;
}

.hover-gap {
  stroke: var(--accent);
  stroke-width: 2;
}

.hover-dot {
  position: absolute;
  width: 8px;
  height: 8px;
  margin: -4px 0 0 -4px;
  border: 2px solid var(--surface-1);
  border-radius: 50%;
  pointer-events: none;
}

.hover-dot.on-line {
  background: var(--accent);
}

.hover-dot.on-ground {
  background: var(--terrain-edge);
}

.readout {
  position: absolute;
  top: 4px;
  padding: 1px 5px;
  font-size: 10.5px;
  white-space: nowrap;
  background: color-mix(in srgb, var(--surface-1) 90%, transparent);
  border-radius: 3px;
  pointer-events: none;
}

.readout.right {
  margin-left: 8px;
}

.readout.left {
  transform: translateX(calc(-100% - 8px));
}

svg {
  display: block;
  width: 100%;
  height: 150px;
  background: var(--surface-2);
  border-radius: 4px;
}

svg * {
  vector-effect: non-scaling-stroke;
}

.terrain {
  fill: var(--terrain);
  stroke: var(--terrain-edge);
  stroke-width: 1;
}

.fresnel {
  fill: var(--accent);
  opacity: 0.18;
}

.los {
  stroke: var(--accent);
  stroke-width: 1.5;
}

.mast {
  stroke-width: 3;
}

.mast.node-a {
  stroke: var(--node-a);
}

.mast.node-b {
  stroke: var(--node-b);
}

.worst-guide {
  stroke: var(--status-critical);
  stroke-width: 1;
  stroke-dasharray: 3 3;
}

.ends {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 3px;
  font-size: 10.5px;
}

.ends span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scale {
  color: var(--text-muted);
}

.node-a {
  color: var(--node-a);
}

.node-b {
  color: var(--node-b);
}

.key {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 10.5px;
  color: var(--text-secondary);
}

.sw {
  display: inline-block;
  width: 14px;
  height: 8px;
  margin-right: 5px;
  vertical-align: middle;
  border-radius: 2px;
}

.sw.terrain {
  background: var(--terrain);
}

.sw.los {
  height: 2px;
  background: var(--accent);
}

.sw.fresnel {
  background: color-mix(in srgb, var(--accent) 30%, transparent);
}

.heights {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin: 0;
  padding: 0;
  border: 0;
  font-size: 11px;
}

.heights legend {
  width: 100%;
  margin-bottom: 4px;
  padding: 0;
  color: var(--text-secondary);
}

.heights label {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}

.heights label span {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.heights input {
  width: 52px;
  padding: 2px 4px;
  background: var(--surface-0);
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text-primary);
  font-family: var(--mono);
  font-size: 11px;
}

.mono {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}
</style>
