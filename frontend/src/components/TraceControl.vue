<script setup lang="ts">
import { computed } from 'vue'
import { useMeshStore } from '@/stores/mesh'
import { useTraceStore } from '@/stores/trace'

const emit = defineEmits<{ run: [] }>()

const trace = useTraceStore()
const mesh = useMeshStore()

const anySupport = trace.available.ble || trace.available.serial

function nameOf(key: string): string {
  if (key === trace.companion?.publicKey) return trace.companion.name || 'compagnon'
  const n = mesh.nodes.features.find((f) => f.properties.key === key)
  return n?.properties.name || key.slice(0, 8)
}

const fmtDb = (v: number) => `${v.toFixed(2).replace('.', ',').replace(/,?0+$/, '')} dB`

const hops = computed(() => (trace.result?.ok ? trace.result.hops : []))
</script>

<template>
  <div class="trace">
    <button
      type="button"
      class="toggle"
      :class="{ on: trace.open, live: trace.status === 'connected' }"
      title="Trace depuis un compagnon"
      aria-label="Trace depuis un compagnon"
      :aria-expanded="trace.open"
      aria-controls="trace-panel"
      @click="trace.open = !trace.open"
    >
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
        <circle cx="4" cy="15" r="2" />
        <circle cx="10" cy="5" r="2" />
        <circle cx="16" cy="13" r="2" />
        <path d="M5.2 13.3 8.8 6.7M11.4 6.5l3.3 4.8" />
      </svg>
    </button>

    <section v-if="trace.open" id="trace-panel" class="panel" aria-label="Trace">
      <header>
        <h3>Trace</h3>
        <button type="button" class="close" aria-label="Fermer" @click="trace.open = false">✕</button>
      </header>

      <p v-if="!anySupport" class="note">
        Ce navigateur ne peut pas parler à une radio. Utilisez Chrome ou Edge (ordinateur ou Android).
      </p>

      <template v-else-if="trace.status !== 'connected'">
        <p class="note">
          Connectez un compagnon MeshCore pour envoyer une trace le long d'un chemin choisi sur la carte.
        </p>
        <div class="row">
          <button
            v-if="trace.available.ble"
            type="button"
            class="btn"
            :disabled="trace.status === 'connecting'"
            @click="trace.connect('ble')"
          >
            Bluetooth
          </button>
          <button
            v-if="trace.available.serial"
            type="button"
            class="btn"
            :disabled="trace.status === 'connecting'"
            @click="trace.connect('serial')"
          >
            USB
          </button>
          <span v-if="trace.status === 'connecting'" class="note">Connexion…</span>
        </div>
        <p v-if="trace.connectError" class="ko">Connexion impossible : {{ trace.connectError }}</p>
      </template>

      <template v-else>
        <p class="who">
          <span class="dot" aria-hidden="true" />
          {{ trace.companion?.name || 'Compagnon' }}
          <button type="button" class="link" @click="trace.disconnect()">Déconnecter</button>
        </p>
        <p class="note">
          Cliquez les nœuds dans l'ordre, en partant d'un voisin du compagnon. La trace fait l'aller-retour
          et mesure les deux sens de chaque lien.
        </p>

        <ol v-if="trace.path.length" class="path">
          <li v-for="(k, i) in trace.path" :key="k">
            <span class="n mono">{{ i + 1 }}</span>
            <span class="name">{{ nameOf(k) }}</span>
            <button type="button" class="x" :aria-label="`Retirer ${nameOf(k)}`" @click="trace.toggleNode(k)">
              ✕
            </button>
          </li>
        </ol>
        <p v-else class="empty">Aucun nœud sélectionné.</p>

        <div class="row">
          <button type="button" class="btn primary" :disabled="!trace.canRun" @click="emit('run')">
            {{ trace.running ? 'Trace en cours…' : 'Lancer la trace' }}
          </button>
          <button v-if="trace.path.length" type="button" class="btn" :disabled="trace.running" @click="trace.clearPath()">
            Effacer
          </button>
        </div>

        <div v-if="trace.result" class="result" :class="trace.result.ok ? 'ok' : 'ko'" role="status">
          <p class="verdict">
            <strong>{{ trace.result.ok ? 'OK' : 'KO' }}</strong>
            {{ trace.result.ok ? 'la trace est revenue' : trace.result.reason }}
          </p>
          <ul v-if="hops.length" class="hops">
            <li v-for="(h, i) in hops" :key="i">
              <span class="name">{{ nameOf(h.from) }} → {{ nameOf(h.to) }}</span>
              <span class="mono">{{ h.snr !== undefined ? fmtDb(h.snr) : '—' }}</span>
            </li>
          </ul>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.trace {
  position: relative;
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

/* Connected: the icon takes the accent, so the link is visible with the panel shut. */
.toggle.live {
  color: var(--accent);
}

.toggle svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
}

.panel {
  position: absolute;
  top: 0;
  right: 37px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 270px;
  max-height: calc(100vh - 160px);
  overflow-y: auto;
  padding: 10px 12px;
  background: color-mix(in srgb, var(--surface-1) 96%, transparent);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  backdrop-filter: blur(6px);
  box-shadow: 0 4px 14px rgb(0 0 0 / 0.12);
  font-size: 12px;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

h3 {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
}

.close,
.x {
  padding: 0 2px;
  background: none;
  border: 0;
  color: var(--text-muted);
  cursor: pointer;
}

p {
  margin: 0;
}

.note,
.empty {
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-muted);
}

.row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.btn {
  padding: 4px 10px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
}

.btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
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

.link {
  margin-left: auto;
  padding: 0;
  background: none;
  border: 0;
  color: var(--text-secondary);
  font-size: 11px;
  text-decoration: underline;
  cursor: pointer;
}

.path,
.hops {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.path li,
.hops li {
  display: flex;
  align-items: center;
  gap: 6px;
}

.n {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 17px;
  height: 17px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  font-size: 10px;
}

.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.result {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid currentColor;
  border-radius: 4px;
}

.result.ok {
  color: var(--status-good);
}

.result.ko,
.ko {
  color: var(--status-critical);
}

.result .hops {
  color: var(--text-primary);
  font-size: 11px;
}

.mono {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}

@media (max-width: 760px) {
  .panel {
    width: min(270px, calc(100vw - 70px));
  }
}
</style>
