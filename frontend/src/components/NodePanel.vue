<script setup lang="ts">
import { computed, ref } from 'vue'
import type { BackboneLevel, NodeDetail, NodeNeighbor } from '@/api/types'
import { snrBucketIndex } from '@/styles/scale'
import { formatDuration } from '@/utils/duration'
import ShareButton from './ShareButton.vue'
import WarnIcon from './WarnIcon.vue'
import NodeAdmin from './NodeAdmin.vue'
import { useTraceStore } from '@/stores/trace'

const props = defineProps<{
  nodeKey: string
  detail: NodeDetail | null
  thresholds: number[]
}>()

const emit = defineEmits<{ close: []; openLink: [string] }>()

const typeLabel: Record<string, string> = {
  repeater: 'Répéteur',
  companion: 'Compagnon',
  room: 'Room server',
  sensor: 'Capteur',
  none: 'Inconnu',
}

const kindLabel: Record<string, string> = {
  measured: 'Mesuré',
  trace: 'Trace',
  topology: 'Topo',
}

const LEVELS: { id: BackboneLevel; label: string; hint: string }[] = [
  { id: 'low', label: 'Faible', hint: "d'autres chemins existent" },
  { id: 'medium', label: 'Moyen', hint: 'relie des groupes ou porte du trafic' },
  { id: 'high', label: 'Élevé', hint: 'nœud de passage majeur' },
  { id: 'critical', label: 'Critique', hint: 'seul relais entre deux groupes' },
]

const ramp = ['var(--snr-1)', 'var(--snr-2)', 'var(--snr-3)', 'var(--snr-4)']

function snrColor(snr: number | null): string {
  if (snr === null) return 'var(--no-data)'
  return ramp[snrBucketIndex(snr, props.thresholds)] ?? ramp[3]!
}

const node = computed(() => props.detail?.node)

/**
 * With a companion connected, the owner of a repeater or room server can open
 * a session on it from here (NodeAdmin) and fix what the ⚠ flags in one click.
 */
const companion = useTraceStore()
const manageable = computed(
  () => companion.status === 'connected' && (node.value?.nodeType === 'repeater' || node.value?.nodeType === 'room'),
)
const nodeAdmin = ref<InstanceType<typeof NodeAdmin> | null>(null)
const canFix = computed(() => nodeAdmin.value?.isAdmin === true)
const fixReply = ref<Record<string, string>>({})
const regionDraft = ref('')
async function fix(id: string, command: string) {
  fixReply.value = { ...fixReply.value, [id]: '…' }
  try {
    fixReply.value = { ...fixReply.value, [id]: (await nodeAdmin.value!.fix(command)) || 'OK' }
  } catch (e) {
    fixReply.value = { ...fixReply.value, [id]: e instanceof Error ? e.message : String(e) }
  }
}
const mapPosition = computed<[number, number] | undefined>(() =>
  node.value?.lat != null && node.value?.lon != null ? [node.value.lon, node.value.lat] : undefined,
)
/** An observer never seen relaying: its "neighbours" are what it hears, not links of the mesh. */
const listenOnly = computed(() => node.value?.listenOnly === true)
const name = computed(() => node.value?.name || props.nodeKey.slice(0, 8))
const backbone = computed(() => props.detail?.backbone)
const levelIndex = computed(() => LEVELS.findIndex((l) => l.id === backbone.value?.level))
const level = computed(() => (levelIndex.value >= 0 ? LEVELS[levelIndex.value] : undefined))

const neighbors = computed<NodeNeighbor[]>(() => props.detail?.neighbors ?? [])
const measuredCount = computed(() => neighbors.value.filter((n) => n.snrQuality !== null).length)

function position(): string {
  const n = node.value
  if (!n || n.lat === null || n.lon === null) return '—'
  return `${n.lat.toFixed(4)}, ${n.lon.toFixed(4)}`
}

function snr(v: number | null): string {
  return v === null ? '—' : v.toFixed(1)
}
</script>

<template>
  <aside class="panel">
    <header>
      <div class="titles">
        <h2>{{ name }}</h2>
        <p class="sub">
          <span class="type">{{ typeLabel[node?.nodeType ?? 'none'] ?? node?.nodeType }}</span>
          <span v-if="detail?.ageSec !== undefined" class="mono">
            actif il y a {{ formatDuration(detail.ageSec) }}
          </span>
        </p>
      </div>
      <ShareButton :title="`${name} — MeshQual`" />
      <button class="close" type="button" aria-label="Fermer le panneau" @click="emit('close')">
        ✕
      </button>
    </header>

    <p v-if="!detail" class="loading">Chargement…</p>

    <template v-else>
      <p v-if="listenOnly" class="listen">
        <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M6 1 11 6 6 11 1 6Z" /></svg>
        Observateur en écoute seule : il publie ce qu'il entend mais n'a pas été vu relayer depuis 48 h. Ses liens ne
        sont pas tracés sur la carte.
      </p>
      <div class="tiles">
        <div class="tile">
          <span class="t-label">{{ listenOnly ? 'Entendus' : 'Voisins' }}</span>
          <span class="t-value mono">{{ neighbors.length }}</span>
          <span class="t-hint">dont {{ measuredCount }} avec un SNR</span>
        </div>
        <div v-if="level" class="tile level" :class="level.id">
          <span class="t-label">Rôle de pont</span>
          <span class="t-value">
            <i
              class="pi"
              :class="level.id === 'critical' || level.id === 'high' ? 'pi-exclamation-triangle' : 'pi-share-alt'"
              aria-hidden="true"
            />
            {{ level.label }}
          </span>
          <span class="t-hint">{{ level.hint }}</span>
        </div>
        <div class="tile">
          <span class="t-label">Position</span>
          <span class="t-value mono small">{{ position() }}</span>
        </div>
        <div class="tile">
          <span class="t-label">Hash de chemin</span>
          <span class="t-value mono small">
            <WarnIcon v-if="node?.pathHashSize === 1" />
            {{ node?.pathHashSize ? `${node.pathHashSize} octet${node.pathHashSize > 1 ? 's' : ''}` : '—' }}
          </span>
          <span class="t-hint">{{
            node?.pathHashSize === 1
              ? 'collisions fréquentes : set path.hash.mode 1 pour 2 octets'
              : node?.pathHashSize
                ? 'lu dans ses annonces relayées'
                : 'aucune annonce relayée reçue'
          }}</span>
          <span v-if="canFix && node?.pathHashSize === 1" class="fix">
            <button type="button" class="btn-fix" @click="fix('hash', 'set path.hash.mode 1')">Passer en 2 octets</button>
            <small v-if="fixReply.hash">{{ fixReply.hash }}</small>
          </span>
        </div>
        <div class="tile">
          <span class="t-label">Région par défaut</span>
          <span class="t-value mono small">
            <WarnIcon v-if="node?.regionScope === 'none' && (node?.nodeType === 'repeater' || node?.nodeType === 'room')" />
            {{
              node?.regionScope === 'set'
                ? node.regionName || 'inconnue'
                : node?.regionScope === 'none'
                  ? 'aucune'
                  : '—'
            }}
          </span>
          <span class="t-hint">{{
            node?.regionScope === 'none'
              ? 'annonces sans région : region default <nom> puis region save'
              : node?.regionScope === 'set' && !node.regionName
                ? 'nom absent de regionNames, ou région privée'
                : node?.regionScope === 'set'
                  ? 'lue dans ses annonces'
                  : 'aucune annonce relayée reçue'
          }}</span>
          <form
            v-if="canFix && node?.regionScope === 'none'"
            class="fix"
            @submit.prevent="regionDraft.trim() && fix('region', `region default ${regionDraft.trim()}`)"
          >
            <input v-model="regionDraft" placeholder="ex. fr-bre" aria-label="Région par défaut" />
            <button type="submit" class="btn-fix" :disabled="!regionDraft.trim()">Définir</button>
            <small v-if="fixReply.region">{{ fixReply.region }}</small>
          </form>
        </div>
        <div class="tile">
          <span class="t-label">Clé</span>
          <span class="t-value mono small" :title="nodeKey">{{ nodeKey.slice(0, 16) }}…</span>
        </div>
      </div>

      <section v-if="backbone && level">
        <h3>Rôle de pont observé</h3>
        <!-- Four steps, the active one filled; the label carries the meaning. -->
        <div class="gauge" role="img" :aria-label="`Niveau ${level.label}`">
          <span
            v-for="(l, i) in LEVELS"
            :key="l.id"
            class="step"
            :class="[l.id, { on: i <= levelIndex }]"
          />
        </div>
        <ul class="reasons">
          <li v-for="r in backbone.reasons" :key="r">{{ r }}</li>
        </ul>
        <p class="caveat">
          Calculé sur les {{ detail.graph.nodes }} nœuds et {{ detail.graph.links }} liens observés
          ({{ detail.graph.communities }} groupes). 
        </p>
      </section>

      <section>
        <h3>
          {{ neighbors.length }}
          {{
            listenOnly
              ? neighbors.length > 1 ? 'nœuds entendus' : 'nœud entendu'
              : neighbors.length > 1 ? 'voisins connus' : 'voisin connu'
          }}
        </h3>
        <p v-if="neighbors.length === 0" class="empty">Aucun lien actif pour ce nœud.</p>
        <!-- Wider than the panel with long names: it scrolls on its own, not the panel. -->
        <div v-else class="table-scroll">
        <table class="neighbors">
          <thead>
            <tr>
              <th>Nœud</th>
              <th>Lien</th>
              <th title="Qualité : le plus faible des deux sens">SNR</th>
              <th title="Reçu par ce nœud / reçu par le voisin">↓ / ↑</th>
              <th>Dist.</th>
              <th>Vu</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="n in neighbors"
              :key="n.linkId"
              :class="{ static: listenOnly }"
              :tabindex="listenOnly ? undefined : 0"
              :title="listenOnly ? undefined : `Ouvrir le lien avec ${n.name || n.key.slice(0, 8)}`"
              @click="!listenOnly && emit('openLink', n.linkId)"
              @keydown.enter="!listenOnly && emit('openLink', n.linkId)"
            >
              <td class="name">
                {{ n.name || n.key.slice(0, 8) }}
                <span class="ntype">{{ typeLabel[n.nodeType] ?? n.nodeType }}</span>
              </td>
              <td><span class="kind" :class="n.kind">{{ kindLabel[n.kind] ?? n.kind }}</span></td>
              <td class="mono">
                <i class="dot" :style="{ background: snrColor(n.snrQuality) }" aria-hidden="true" />
                {{ snr(n.snrQuality) }}
              </td>
              <td class="mono dirs">{{ snr(n.snrToNode) }} / {{ snr(n.snrFromNode) }}</td>
              <td class="mono">{{ n.distKm === null ? '—' : `${n.distKm.toFixed(1)} km` }}</td>
              <td class="mono">{{ formatDuration(n.ageSec) }}</td>
            </tr>
          </tbody>
        </table>
        </div>
      </section>

      <NodeAdmin
        v-if="manageable && node"
        ref="nodeAdmin"
        :node-key="nodeKey"
        :name="node.name"
        :node-type="node.nodeType"
        :position="mapPosition"
        :observer="node.observer === true"
      />
    </template>
  </aside>
</template>

<style scoped>
.fix {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
}

.fix input {
  width: 80px;
  padding: 1px 4px;
  background: var(--surface-0);
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text-primary);
  font-size: 11px;
}

.btn-fix {
  padding: 1px 6px;
  background: var(--accent);
  border: 0;
  border-radius: 3px;
  color: #fff;
  font-size: 11px;
  cursor: pointer;
}

.btn-fix:disabled {
  opacity: 0.45;
}

.fix small {
  font-size: 10.5px;
  color: var(--text-muted);
}

.listen {
  margin: 0;
  padding: 8px 10px;
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--text-secondary);
  background: var(--surface-2);
  border-radius: 4px;
}

.listen svg {
  margin-right: 4px;
  vertical-align: -1px;
  fill: var(--surface-0);
  stroke: var(--no-data);
  stroke-width: 1.6;
}

tr.static {
  cursor: default;
}

.panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 440px;
  max-height: 100%;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 14px;
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--radius);
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
  font-size: 15px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.sub {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 6px 0 0;
  font-size: 11px;
  color: var(--text-secondary);
}

.type {
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 3px;
  font-size: 10px;
}

.close {
  background: none;
  border: 0;
  color: var(--text-secondary);
  font-size: 14px;
  cursor: pointer;
}

.loading,
.empty {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}

.tiles {
  display: grid;
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
}

.t-value {
  font-size: 19px;
  font-weight: 600;
  line-height: 1.15;
}

.t-value.small {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.t-hint {
  font-size: 9.5px;
  color: var(--text-muted);
}

/* Level colour always comes with its label and an icon, never alone. */
.level .pi {
  font-size: 14px;
}

.level.low .t-value {
  color: var(--text-secondary);
}

.level.medium .t-value {
  color: var(--accent);
}

.level.high .t-value {
  color: var(--status-warning);
}

.level.critical .t-value {
  color: var(--status-critical);
}

h3 {
  margin: 0 0 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.gauge {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 3px;
  margin-bottom: 8px;
}

.step {
  height: 6px;
  border-radius: 2px;
  background: var(--surface-2);
}

.step.on.low {
  background: var(--text-muted);
}

.step.on.medium {
  background: var(--accent);
}

.step.on.high {
  background: var(--status-warning);
}

.step.on.critical {
  background: var(--status-critical);
}

.reasons {
  margin: 0;
  padding-left: 16px;
  font-size: 12px;
  line-height: 1.5;
}

.caveat {
  margin: 8px 0 0;
  font-size: 10.5px;
  line-height: 1.4;
  color: var(--text-muted);
}

.panel > * {
  min-width: 0;
}

.table-scroll {
  overflow-x: auto;
}

.neighbors {
  width: 100%;
  border-collapse: collapse;
  font-size: 11.5px;
}

.neighbors th {
  padding: 4px 6px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-align: left;
  text-transform: uppercase;
  color: var(--text-secondary);
  background: var(--surface-2);
}

.neighbors td {
  padding: 4px 6px;
  border-top: 1px solid var(--border);
  white-space: nowrap;
}

.neighbors tbody tr {
  cursor: pointer;
}

.neighbors tbody tr:hover,
.neighbors tbody tr:focus-visible {
  background: var(--surface-2);
  outline: none;
}

.name {
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ntype {
  display: block;
  font-size: 9.5px;
  color: var(--text-muted);
}

.kind {
  padding: 1px 4px;
  border: 1px solid var(--border);
  border-radius: 3px;
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

.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 4px;
  border-radius: 50%;
  vertical-align: middle;
}

.dirs {
  color: var(--text-secondary);
}

.mono {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}

@media (max-width: 760px) {
  .panel {
    width: auto;
  }
}
</style>
