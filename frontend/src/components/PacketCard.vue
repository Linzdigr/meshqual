<script setup lang="ts">
import { computed } from 'vue'
import type { PacketHop, PacketTrace } from '@/api/types'
import type { PacketPath } from '@/map/packetPath'

const props = defineProps<{
  hash: string
  trace: PacketTrace | null
  path: PacketPath | null
  loading: boolean
  error: string | null
}>()
const emit = defineEmits<{ close: [] }>()

/** Firmware payload types, in words. */
const TYPE_LABEL: Record<string, string> = {
  ADVERT: 'Annonce',
  TXT_MSG: 'Message',
  GRP_TXT: 'Message de canal',
  GRP_DATA: 'Données de canal',
  REQ: 'Requête',
  RESPONSE: 'Réponse',
  ACK: 'Accusé de réception',
  ANON_REQ: 'Requête anonyme',
  PATH: 'Retour de chemin',
  TRACE: 'Trace',
  CONTROL: 'Contrôle',
}

const hopName = (h: PacketHop) => h.name || (h.ambiguous ? `${h.hash} (ambigu)` : h.hash ? `${h.hash} ?` : '?')
const time = (at: string) => new Date(at).toLocaleTimeString('fr-FR')

const observers = computed(() => new Set(props.trace?.receptions.map((r) => r.observer.key).filter(Boolean)).size)
const direct = computed(() => props.trace?.receptions.filter((r) => r.route === 'direct').length ?? 0)
const first = computed(() => props.trace?.receptions[0]?.at)
</script>

<template>
  <section id="packet-card" class="card" aria-label="Chemin du paquet">
    <header>
      <h3>
        <template v-if="trace">{{ TYPE_LABEL[trace.payloadType] ?? trace.payloadType }}</template
        ><template v-else>Paquet</template>
        <span class="mono hash">{{ hash }}</span>
      </h3>
      <button type="button" class="x" aria-label="Fermer" @click="emit('close')">✕</button>
    </header>

    <p v-if="loading" class="muted"><i class="pi pi-spin pi-spinner" aria-hidden="true" /> Recherche des réceptions…</p>
    <p v-else-if="error" class="muted">{{ error }}</p>
    <template v-else-if="trace && path">
      <p>
        {{ trace.receptions.length }} réception{{ trace.receptions.length > 1 ? 's' : '' }} par {{ observers }}
        observateur{{ observers > 1 ? 's' : '' }}<template v-if="first">, à partir de {{ time(first) }}</template
        ><template v-if="trace.origin">, émis par <strong>{{ hopName(trace.origin) }}</strong></template
        >.
      </p>
      <p v-if="path.unplaced" class="muted">
        {{ path.unplaced }} saut{{ path.unplaced > 1 ? 's' : '' }} sans nœud connu ou ambigu{{ path.unplaced > 1 ? 's' : '' }} : en
        pointillés.
      </p>
      <p v-if="direct" class="muted">
        {{ direct }} en routage direct : leur chemin est la route restante, seul l'observateur est tracé.
      </p>
      <details>
        <summary>Réceptions</summary>
        <ol>
          <li v-for="(r, i) in trace.receptions" :key="i">
            <span class="mono at">{{ time(r.at) }}</span>
            <strong>{{ hopName(r.observer) }}</strong>
            <template v-if="r.snr !== undefined"> · <span class="mono">{{ r.snr.toFixed(1) }} dB</span></template>
            <span class="route">
              <template v-if="r.route === 'direct'"
                >routage direct<template v-if="r.hops.length">, reste : {{ r.hops.map(hopName).join(' → ') }}</template></template
              >
              <template v-else-if="r.hops.length">{{ r.hops.map(hopName).join(' → ') }}</template>
              <template v-else>reçu sans relais</template>
            </span>
          </li>
        </ol>
      </details>
    </template>
  </section>
</template>

<style scoped>
.card {
  position: absolute;
  top: 12px;
  left: 50%;
  z-index: 3;
  transform: translateX(-50%);
  width: min(360px, calc(100% - 24px));
  max-height: min(50vh, 420px);
  overflow-y: auto;
  padding: 8px 12px 10px;
  background: color-mix(in srgb, var(--surface-1) 97%, transparent);
  border: 1px solid var(--border);
  border-left: 3px solid #0c8599;
  border-radius: var(--radius);
  backdrop-filter: blur(6px);
  box-shadow: 0 4px 14px rgb(0 0 0 / 0.12);
  font-size: 12px;
  color: var(--text-primary);
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

h3 {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
}

.hash {
  margin-left: 4px;
  font-weight: 400;
  color: var(--text-secondary);
}

.x {
  padding: 2px 4px;
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
}

p {
  margin: 6px 0 0;
  line-height: 1.4;
}

.muted {
  color: var(--text-secondary);
}

.mono {
  font-family: var(--mono);
}

details {
  margin-top: 6px;
}

summary {
  cursor: pointer;
  color: var(--text-secondary);
}

ol {
  margin: 4px 0 0;
  padding-left: 18px;
}

li {
  margin-bottom: 4px;
}

.at {
  margin-right: 6px;
}

.route {
  display: block;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

/* Docked at the bottom like the other panels: the way is framed above it. */
@media (max-width: 760px) {
  .card {
    top: auto;
    bottom: 12px;
    z-index: 5;
    max-height: 45vh;
  }
}
</style>
