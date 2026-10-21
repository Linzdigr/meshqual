<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMeshStore } from '@/stores/mesh'
import { DISCOVER_WINDOW_MS, MAX_TRACE_HOPS, RETRY_GAP_MS, useTraceStore, type CampaignItem } from '@/stores/trace'
import type { Gap } from '@/companion/planner'

const emit = defineEmits<{ run: []; runCampaign: [] }>()

const trace = useTraceStore()
const mesh = useMeshStore()

function nameOf(key: string): string {
  if (key === trace.companion?.publicKey) return trace.companion.name || 'compagnon'
  const n = mesh.nodes.features.find((f) => f.properties.key === key)
  if (n?.properties.name) return n.properties.name
  // Nodes just outside the view are not loaded, but their links name them.
  for (const f of mesh.links.features) {
    const l = f.properties
    if (l.aKey === key && l.aName) return l.aName
    if (l.bKey === key && l.bName) return l.bName
  }
  return key.slice(0, 8)
}

const fmtDb = (v: number) => `${v.toFixed(2).replace('.', ',').replace(/,?0+$/, '')} dB`

const hops = computed(() => (trace.result?.ok ? trace.result.hops : []))

const tokenDraft = ref('')

const gapLabel: Record<Gap, string> = {
  unmeasured: 'jamais mesuré',
  oneWay: 'un seul sens',
  few: 'peu de mesures',
  stale: 'mesure ancienne',
}

/** The automatic traces to show: the campaign once started, else the proposal. */
const autoList = computed<CampaignItem[]>(() =>
  trace.campaign.length ? trace.campaign : trace.proposal.map((p) => ({ ...p, status: 'pending' })),
)
const tally = computed(() => ({
  ok: trace.campaign.filter((c) => c.status === 'ok').length,
  ko: trace.campaign.filter((c) => c.status === 'ko').length,
}))
const statusMark: Record<string, string> = { pending: '·', running: '…', ok: '✓', ko: '✕' }

/** Observers picked by hand: allowed, but likely to stop the trace. */
const pickedObservers = computed(() => [
  ...new Set(trace.path.filter((k) => trace.observers.has(k)).map(nameOf)),
])

/** The path does not come back to where it started: the companion may not hear its end. */
const endsAway = computed(() => trace.path.length > 1 && trace.path[0] !== trace.path.at(-1))
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
      <!-- A radio on the air: the companion, not the mesh or a share. -->
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
        <circle cx="10" cy="8" r="1.6" />
        <path d="M10 9.6V18M7 15.5h6" />
        <path d="M6.6 4.6a4.8 4.8 0 0 0 0 6.8M13.4 4.6a4.8 4.8 0 0 1 0 6.8" />
        <path d="M4.2 2.2a8.2 8.2 0 0 0 0 11.6M15.8 2.2a8.2 8.2 0 0 1 0 11.6" />
      </svg>
    </button>

    <section v-if="trace.open" id="trace-panel" class="panel" aria-label="Trace">
      <header>
        <h3>Trace (EXPERIMENTAL)</h3>
        <button type="button" class="close" aria-label="Fermer" @click="trace.open = false">✕</button>
      </header>

      <!-- Shown only once a companion is connected (CompanionButton). -->
      <template v-if="trace.status === 'connected'">

        <!-- Observers hear part of a trace; the companion gets every hop. With the
             server's token, results go to the map as well. -->
        <div v-if="trace.submitEnabled" class="submit">
          <form v-if="!trace.token" class="row" @submit.prevent="trace.setToken(tokenDraft)">
            <input
              v-model="tokenDraft"
              type="password"
              autocomplete="off"
              placeholder="Jeton d'envoi à la carte"
              aria-label="Jeton d'envoi à la carte"
            />
            <button type="submit" class="btn" :disabled="!tokenDraft.trim()">OK</button>
          </form>
          <p v-else class="note">
            <span :class="{ ko: trace.submitError }">
              {{
                trace.submitError
                  ? `Envoi à la carte : ${trace.submitError}`
                  : `Mesures envoyées à la carte : ${trace.submitted}`
              }}
            </span>
            <button type="button" class="link" @click="trace.setToken('')">changer le jeton</button>
          </p>
        </div>
        <div class="modes" role="radiogroup" aria-label="Mode">
          <button
            type="button"
            role="radio"
            :aria-checked="trace.mode === 'manual'"
            :class="{ on: trace.mode === 'manual' }"
            :disabled="trace.busy"
            @click="trace.mode = 'manual'"
          >
            Manuel
          </button>
          <button
            type="button"
            role="radio"
            :aria-checked="trace.mode === 'auto'"
            :class="{ on: trace.mode === 'auto' }"
            :disabled="trace.busy"
            @click="trace.mode = 'auto'"
          >
            Automatique
          </button>
        </div>

        <template v-if="trace.mode === 'auto'">
          <section class="step">
            <h4>1. Relais à portée</h4>
            <div class="row">
              <button type="button" class="btn" :disabled="trace.busy" @click="trace.discover()">
                {{ trace.discovering ? 'Écoute des réponses…' : trace.discoveredAt ? 'Relancer la détection' : 'Détecter' }}
              </button>
              <span v-if="trace.discovering" class="note">{{ DISCOVER_WINDOW_MS / 1000 }} s</span>
            </div>
            <ul v-if="trace.discovered.length" class="hops">
              <li v-for="r in trace.discovered" :key="r.publicKey">
                <span class="name">
                  {{ nameOf(r.publicKey) }}
                  <small v-if="trace.observers.has(r.publicKey)" class="muted">observateur en écoute seule, non utilisé</small>
                </span>
                <span class="mono" title="SNR reçu par le relais / reçu par le compagnon">
                  ↑ {{ fmtDb(r.snrAtRepeater) }} · ↓ {{ fmtDb(r.snrAtCompanion) }}
                </span>
              </li>
            </ul>
            <p v-else-if="trace.discoveredAt && !trace.discovering" class="warn">
              Aucun relais n'a répondu. Chacun répond au plus 4 fois par 2 minutes : réessayez un peu plus tard.
            </p>
          </section>

          <section v-if="trace.discovered.length" class="step">
            <h4>2. Traces proposées</h4>
            <label class="depth">
              Jusqu'à
              <select v-model.number="trace.depth" :disabled="trace.busy">
                <option :value="1">1 saut</option>
                <option :value="2">2 sauts</option>
                <option :value="3">3 sauts</option>
              </select>
              au-delà des relais à portée
            </label>
            <ol v-if="autoList.length" class="plan">
              <li v-for="(c, i) in autoList" :key="i" :class="c.status">
                <span class="mark mono" aria-hidden="true">{{ statusMark[c.status] }}</span>
                <span class="name">
                  {{ nameOf(c.target.a) }} → {{ nameOf(c.target.b) }}
                  <small>{{ gapLabel[c.target.gap] }} · {{ c.path.length + 1 }} sauts</small>
                  <small v-if="c.result && !c.result.ok" class="ko">{{ c.result.reason }}</small>
                </span>
              </li>
            </ol>
            <p v-else class="note">Rien à compléter autour de ces relais d'après la carte.</p>
            <div class="row">
              <button
                v-if="!trace.campaignRunning"
                type="button"
                class="btn primary"
                :disabled="trace.busy || !trace.proposal.length"
                @click="emit('runCampaign')"
              >
                Lancer {{ trace.proposal.length }} trace{{ trace.proposal.length > 1 ? 's' : '' }}
              </button>
              <button v-else type="button" class="btn" @click="trace.stopCampaign()">Arrêter</button>
              <span v-if="trace.campaign.length" class="mono tally">
                <span class="ok">{{ tally.ok }} OK</span> · <span class="ko">{{ tally.ko }} KO</span>
              </span>
            </div>
            <p class="note">
              Les traces partent une à une, espacées de quelques secondes. Leurs mesures n'arrivent sur la
              carte que si un observateur les entend passer.
            </p>
          </section>
        </template>

        <template v-else>
        <p class="note">
          Cliquez les nœuds dans l'ordre de l'aller puis du retour, en partant d'un voisin du compagnon.
          Un nœud peut revenir au retour ; recliquer le dernier l'annule.
        </p>

        <ol v-if="trace.path.length" class="path">
          <li v-for="(k, i) in trace.path" :key="i">
            <span class="n mono">{{ i + 1 }}</span>
            <span class="name">{{ nameOf(k) }}</span>
            <button type="button" class="x" :aria-label="`Retirer l'étape ${i + 1}`" @click="trace.removeAt(i)">
              ✕
            </button>
          </li>
        </ol>
        <p v-else class="empty">Aucun nœud sélectionné.</p>

        <button
          v-if="trace.path.length > 1 && !trace.isRoundTrip"
          type="button"
          class="link back"
          :disabled="trace.path.length * 2 - 1 > MAX_TRACE_HOPS"
          @click="trace.completeReturn()"
        >
          ↩ Retour par le même chemin
        </button>
        <p v-if="endsAway" class="warn">
          La trace se termine sur {{ nameOf(trace.path.at(-1)!) }} : le compagnon doit l'entendre pour
          recevoir le résultat.
        </p>
        <p v-if="pickedObservers.length" class="warn">
          {{ pickedObservers.join(', ') }} : observateur{{ pickedObservers.length > 1 ? 's' : '' }} en écoute
          seule, pas vu{{ pickedObservers.length > 1 ? 's' : '' }} relayer depuis 48 h. La trace risque de s'y arrêter.
        </p>
        <p v-if="trace.path.length >= MAX_TRACE_HOPS" class="warn">
          {{ MAX_TRACE_HOPS }} étapes au plus : le paquet ne peut pas en porter davantage.
        </p>

        <label class="retry">
          <input v-model="trace.retryUntilBack" type="checkbox" :disabled="trace.running" />
          Relancer toutes les {{ RETRY_GAP_MS / 1000 }} s jusqu'au retour
        </label>
        <div class="row">
          <button v-if="!trace.running" type="button" class="btn primary" :disabled="!trace.canRun" @click="emit('run')">
            Lancer la trace
          </button>
          <template v-else>
            <span class="note mono">
              {{ trace.retryUntilBack ? `Tentative ${trace.attempts}…` : 'Trace en cours…' }}
            </span>
            <button v-if="trace.retryUntilBack" type="button" class="btn" @click="trace.stopCampaign()">
              Arrêter
            </button>
          </template>
          <button v-if="trace.path.length" type="button" class="btn" :disabled="trace.running" @click="trace.clearPath()">
            Effacer
          </button>
        </div>

        <div v-if="trace.result" class="result" :class="trace.result.ok ? 'ok' : 'ko'" role="status">
          <p class="verdict">
            <strong>{{ trace.result.ok ? 'OK' : 'KO' }}</strong>
            {{ trace.result.ok ? ' - trace complète' : trace.result.reason }}
            <span v-if="trace.retryUntilBack && trace.resultAttempt > 0" class="mono attempts">
              ({{ trace.result.ok ? 'revenue à la tentative' : 'tentative' }} {{ trace.resultAttempt }})
            </span>
          </p>
          <ul v-if="hops.length" class="hops">
            <li v-for="(h, i) in hops" :key="i">
              <span class="name">{{ nameOf(h.from) }} → {{ nameOf(h.to) }}</span>
              <span class="mono">{{ h.snr !== undefined ? fmtDb(h.snr) : '—' }}</span>
            </li>
          </ul>
        </div>
        </template>
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

.back {
  align-self: flex-start;
  margin-left: 0;
  font-size: 11.5px;
}

.warn {
  font-size: 11px;
  line-height: 1.4;
  color: var(--status-warning);
}

.retry {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text-secondary);
  cursor: pointer;
}

.attempts {
  font-size: 11px;
  color: var(--text-muted);
}

.submit input {
  flex: 1;
  min-width: 0;
  padding: 3px 6px;
  background: var(--surface-0);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 11.5px;
}

.submit .note {
  display: flex;
  gap: 8px;
  align-items: baseline;
}

.modes {
  display: flex;
  gap: 2px;
  padding: 2px;
  background: var(--surface-2);
  border-radius: 5px;
}

.modes button {
  flex: 1;
  padding: 4px 6px;
  background: none;
  border: 0;
  border-radius: 4px;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
}

.modes button.on {
  background: var(--surface-0);
  color: var(--text-primary);
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.12);
}

.step {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

h4 {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-primary);
}

.depth {
  font-size: 11px;
  color: var(--text-secondary);
}

.depth select {
  margin: 0 2px;
  font-size: 11px;
}

.plan {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.plan li {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  font-size: 11.5px;
}

.hops .name small.muted {
  margin-left: 4px;
  font-size: 10px;
  color: var(--text-muted);
}

.plan .name small {
  display: block;
  font-size: 10.5px;
  color: var(--text-muted);
}

.plan .name {
  white-space: normal;
}

.plan .mark {
  width: 12px;
  text-align: center;
  color: var(--text-muted);
}

.plan li.running .mark {
  color: var(--accent);
}

.plan li.ok .mark,
.tally .ok {
  color: var(--status-good);
}

.plan li.ko .mark,
.plan .name small.ko,
.tally .ko {
  color: var(--status-critical);
}

.tally {
  font-size: 11px;
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
