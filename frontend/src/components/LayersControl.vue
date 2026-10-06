<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ALTITUDE_COLORS, type AltitudeRange } from '@/map/elevation'

const props = defineProps<{
  altitude: boolean
  /** The altitudes the colours span right now; null until the first tiles are read. */
  range: AltitudeRange | null
}>()

const emit = defineEmits<{
  toggleAltitude: []
}>()

const open = ref(false)
const root = ref<HTMLElement | null>(null)

// High ground on top, as on any altitude scale.
const gradient = computed(() => `linear-gradient(to top, ${ALTITUDE_COLORS.join(', ')})`)

function onDocPointer(e: PointerEvent) {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') open.value = false
}
onMounted(() => {
  document.addEventListener('pointerdown', onDocPointer)
  document.addEventListener('keydown', onKey)
})
onUnmounted(() => {
  document.removeEventListener('pointerdown', onDocPointer)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div ref="root" class="layers">
    <button
      type="button"
      class="toggle"
      :class="{ on: open }"
      title="Calques"
      aria-label="Calques"
      :aria-expanded="open"
      aria-controls="layers-menu"
      @click="open = !open"
    >
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
        <path d="M10 3 2.5 7 10 11l7.5-4z" />
        <path d="m2.5 10.5 7.5 4 7.5-4" />
        <path d="m2.5 14 7.5 4 7.5-4" />
      </svg>
    </button>

    <div v-if="open" id="layers-menu" class="menu" role="group" aria-label="Calques">
      <h3>Calques</h3>
      <label class="item">
        <input type="checkbox" :checked="altitude" @change="emit('toggleAltitude')" />
        <span>
          Altitude
          <small>Couleurs du plus bas au plus haut de la zone affichée, recalculées à chaque déplacement.</small>
        </span>
      </label>
    </div>

    <figure
      v-if="altitude"
      class="scale"
      :aria-label="range ? `Altitude de ${range.lo} à ${range.hi} mètres` : 'Altitude'"
    >
      <span class="mono">{{ range ? `${range.hi} m` : '…' }}</span>
      <i class="bar" :style="{ background: gradient }" aria-hidden="true" />
      <span class="mono">{{ range ? `${range.lo} m` : '…' }}</span>
    </figure>
  </div>
</template>

<style scoped>
.layers {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}

.toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 29px;
  height: 29px;
  padding: 0;
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: 4px;
  box-shadow: 0 0 0 2px rgb(0 0 0 / 0.1);
  color: var(--text-secondary);
  cursor: pointer;
}

.toggle:hover,
.toggle.on {
  color: var(--text-primary);
  background: var(--surface-2);
}

.toggle svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linejoin: round;
}

.menu {
  position: absolute;
  top: 0;
  right: 37px;
  width: 230px;
  padding: 10px 12px;
  background: color-mix(in srgb, var(--surface-1) 96%, transparent);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  backdrop-filter: blur(6px);
  box-shadow: 0 4px 14px rgb(0 0 0 / 0.12);
}

h3 {
  margin: 0 0 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
}

.item {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  font-size: 12px;
  cursor: pointer;
}

.item input {
  margin: 2px 0 0;
}

.item small {
  display: block;
  margin-top: 2px;
  font-size: 10.5px;
  line-height: 1.35;
  color: var(--text-muted);
}

.scale {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  margin: 0;
  padding: 5px 3px;
  min-width: 29px;
  background: color-mix(in srgb, var(--surface-1) 90%, transparent);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 10px;
  color: var(--text-secondary);
}

.bar {
  width: 10px;
  height: 110px;
  border-radius: 2px;
}

.mono {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

@media (max-width: 760px) {
  .bar {
    height: 70px;
  }
}
</style>
