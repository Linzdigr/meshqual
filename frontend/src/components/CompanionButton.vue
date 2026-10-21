<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useTraceStore } from '@/stores/trace'

/**
 * Connects a MeshCore companion radio to the browser (Bluetooth or USB). Once
 * connected, the trace tool shows up and node panels offer to manage the
 * owner's nodes through it.
 */
defineProps<{
  /** A side panel is open: icon only on a desktop, hidden on a phone. */
  compact?: boolean
}>()

const companion = useTraceStore()
const open = ref(false)
const root = ref<HTMLElement | null>(null)
const anySupport = companion.available.ble || companion.available.serial

async function connect(kind: 'ble' | 'serial') {
  await companion.connect(kind)
  if (companion.status === 'connected') open.value = false
}

async function disconnect() {
  await companion.disconnect()
  open.value = false
}

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
  <div ref="root" class="companion" :class="{ compact }">
    <div v-if="open" id="companion-menu" class="menu" role="group" aria-label="Compagnon">
      <template v-if="companion.status === 'connected'">
        <p class="who">
          <span class="dot" aria-hidden="true" />
          {{ companion.companion?.name || 'Compagnon' }}
        </p>
        <p class="note">Connecté : outil Trace et gestion de vos nœuds disponibles.</p>
        <button type="button" class="btn" @click="disconnect">Déconnecter</button>
      </template>
      <template v-else>
        <p v-if="!anySupport" class="note">
          Ce navigateur ne peut pas parler à une radio. Utilisez Chrome ou Edge (ordinateur ou Android).
        </p>
        <template v-else>
          <p class="note">Reliez un compagnon MeshCore pour lancer des traces et gérer vos nœuds.</p>
          <div class="row">
            <button
              v-if="companion.available.ble"
              type="button"
              class="btn"
              :disabled="companion.status === 'connecting'"
              @click="connect('ble')"
            >
              Bluetooth
            </button>
            <button
              v-if="companion.available.serial"
              type="button"
              class="btn"
              :disabled="companion.status === 'connecting'"
              @click="connect('serial')"
            >
              USB
            </button>
            <span v-if="companion.status === 'connecting'" class="note">Connexion…</span>
          </div>
          <p v-if="companion.connectError" class="ko">Connexion impossible : {{ companion.connectError }}</p>
        </template>
      </template>
    </div>

    <button
      type="button"
      class="toggle"
      :class="{ live: companion.status === 'connected' }"
      :aria-expanded="open"
      aria-controls="companion-menu"
      :aria-label="companion.status === 'connected' ? `Compagnon : ${companion.companion?.name ?? ''}` : 'Connecter un compagnon'"
      @click="open = !open"
    >
      <!-- The Bluetooth rune: how a companion is usually reached. -->
      <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
        <path d="M6 6.5 14 13.5 10 17V3l4 3.5L6 13.5" />
      </svg>
      <span class="label">
        {{ companion.status === 'connected' ? companion.companion?.name || 'Compagnon' : 'Connecter un compagnon' }}
      </span>
    </button>
  </div>
</template>

<style scoped>
/* Bottom right, above MapLibre's attribution. */
.companion {
  position: absolute;
  right: 10px;
  bottom: 38px;
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 220px;
  padding: 6px 10px;
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 2px 8px rgb(0 0 0 / 0.15);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
}

.toggle:hover {
  color: var(--text-primary);
  background: var(--surface-2);
}

.toggle.live {
  color: var(--accent);
}

.toggle svg {
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.menu {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 260px;
  padding: 10px 12px;
  background: color-mix(in srgb, var(--surface-1) 96%, transparent);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  backdrop-filter: blur(6px);
  box-shadow: 0 4px 14px rgb(0 0 0 / 0.12);
  font-size: 12px;
}

p {
  margin: 0;
}

.note {
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-muted);
}

.ko {
  font-size: 11.5px;
  color: var(--status-critical);
}

.row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.btn {
  align-self: flex-start;
  padding: 4px 10px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
}

.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.who {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--status-good);
}

.compact .label {
  display: none;
}

.compact .toggle {
  padding: 7px;
}

/* Phones: the icon alone, and out of the way of a docked panel. */
@media (max-width: 760px) {
  .label {
    display: none;
  }

  .toggle {
    padding: 7px;
  }

  .menu {
    width: min(260px, calc(100vw - 32px));
  }

  .companion.compact {
    display: none;
  }
}
</style>
