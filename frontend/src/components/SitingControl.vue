<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useSitingStore } from '@/stores/siting'
import { MIN_CUT, SNR_REF_DB, type Proposal } from '@/siting/plan'
import { MAX_VIEW_KM } from '@/siting/run'

const emit = defineEmits<{ focus: [Proposal] }>()

const siting = useSitingStore()
const r = computed(() => siting.result)
const expanded = ref<string | null>(null)

// A site clicked on the map opens its entry.
watch(
  () => siting.selected,
  (id) => {
    if (!id) return
    siting.open = true
    expanded.value = id
  },
)

function pick(p: Proposal) {
  siting.selected = p.id
  expanded.value = expanded.value === p.id ? null : p.id
  emit('focus', p)
}

const summary = computed(() => {
  const res = r.value
  if (!res) return null
  return {
    islands: res.islands.length,
    joined: res.islands.filter((i) => i.joined).length,
    cuts: res.cutNodes.length,
    backed: res.cutNodes.filter((c) => c.after < MIN_CUT).length,
  }
})
const unresolvedIslands = computed(() => r.value?.islands.filter((i) => !i.joined) ?? [])
const unresolvedCuts = computed(() => r.value?.cutNodes.filter((c) => c.after >= MIN_CUT) ?? [])

const fmtSnr = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1).replace('.', ',')} dB`
const fmtKm = (v: number) => `${v.toFixed(1).replace('.', ',')} km`
const clearanceLabel = (c: number) => (c >= 0.6 ? 'dégagée' : c >= 0 ? 'partielle' : 'obstruée')
const clearanceClass = (c: number) => (c >= 0.6 ? 'clear' : c >= 0 ? 'partial' : 'blocked')
const names = (n: string[]) => (n.length <= 3 ? n.join(', ') : `${n.slice(0, 3).join(', ')}…`)
</script>

<template>
  <div class="siting">
    <button
      type="button"
      class="toggle"
      :class="{ on: siting.open, has: !!r?.proposals.length }"
      title="Où placer un nœud ?"
      aria-label="Où placer un nœud ?"
      :aria-expanded="siting.open"
      aria-controls="siting-panel"
      @click="siting.open = !siting.open"
    >
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
        <circle cx="10" cy="10" r="7" />
        <circle cx="10" cy="10" r="3.5" />
        <path d="M10 1v3M10 16v3M1 10h3M16 10h3" />
      </svg>
    </button>

    <section v-if="siting.open" id="siting-panel" class="panel" aria-label="Où placer un nœud ?">
      <header>
        <h3>Où placer un nœud ?</h3>
        <button type="button" class="x" aria-label="Fermer" @click="siting.open = false">✕</button>
      </header>
      <p class="lead">
        Sites à fort intérêt pour la vue en cours : d'abord relier les îlots au réseau, puis doubler les nœuds dont
        d'autres dépendent seuls. Seulement les sites nécessaires.
      </p>

      <div class="controls">
        <label>
          Antenne
          <input v-model.number="siting.antennaM" type="number" min="1" max="100" step="1" :disabled="siting.state === 'running'" />
          m
        </label>
        <button type="button" class="run" :disabled="siting.state === 'running' || siting.tooWide" @click="siting.run()">
          {{ siting.state === 'running' ? 'Calcul…' : r ? 'Recalculer' : 'Calculer pour cette vue' }}
        </button>
        <button v-if="r || siting.state === 'running'" type="button" class="link" @click="siting.clear()">Effacer</button>
      </div>

      <p v-if="siting.tooWide && siting.state !== 'running' && (!r || siting.stale)" class="stale">
        Vue trop large ({{ Math.round(siting.viewKm) }} km) : zoomer jusqu'à {{ MAX_VIEW_KM }} km de large au plus.
      </p>
      <p v-else-if="siting.state === 'running'" class="progress" role="status">
        {{ siting.step }}<template v-if="siting.done > 0"> · {{ Math.round(siting.done * 100) }} %</template>
      </p>
      <p v-else-if="siting.error" class="ko" role="alert">{{ siting.error }}</p>
      <p v-else-if="r && siting.stale" class="stale">La vue a changé depuis le calcul : recalculer pour celle-ci.</p>

      <p v-if="r && siting.demMissing && siting.state !== 'running'" class="ko">
        Relief incomplet : {{ siting.demMissing.missing }} tuile{{ siting.demMissing.missing > 1 ? 's' : '' }} sur
        {{ siting.demMissing.total }} non chargée{{ siting.demMissing.missing > 1 ? 's' : '' }}, résultats partiels.
        Recalculer plus tard.
      </p>

      <template v-if="r && summary && siting.state !== 'running'">
        <p class="summary">
          <template v-if="!summary.islands && !summary.cuts">Aucune faiblesse dans la vue : rien à proposer.</template>
          <template v-else>
            <b>{{ r.proposals.length }} site{{ r.proposals.length > 1 ? 's' : '' }}</b>
            pour {{ summary.joined }} îlot{{ summary.joined > 1 ? 's' : '' }} relié{{ summary.joined > 1 ? 's' : '' }} sur
            {{ summary.islands }} et {{ summary.backed }} point{{ summary.backed > 1 ? 's' : '' }} de passage doublé{{
              summary.backed > 1 ? 's' : ''
            }}
            sur {{ summary.cuts }}.
          </template>
        </p>

        <ol class="sites">
          <li v-for="(p, i) in r.proposals" :key="p.id" :class="{ open: expanded === p.id }">
            <button type="button" class="site" @click="pick(p)">
              <span class="n">{{ i + 1 }}</span>
              <span class="what">
                <span v-for="j in p.joins" :key="j.names.join()">relie {{ names(j.names) }} ({{ j.size }} nœuds)</span>
                <span v-for="b in p.backs" :key="b.key">double {{ b.name }} ({{ b.before }} → {{ b.after }} dépendants)</span>
              </span>
              <span class="mono alt">{{ p.elevM }} m</span>
            </button>
            <p v-if="expanded === p.id" class="reach">
              Atteindrait {{ p.reaches }} nœud{{ p.reaches > 1 ? 's' : '' }} ; les plus utiles :
            </p>
            <table v-if="expanded === p.id" class="links">
              <thead>
                <tr>
                  <th>Lien prévu</th>
                  <th>Dist.</th>
                  <th>SNR</th>
                  <th>Fresnel</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="l in p.links" :key="l.key">
                  <td>{{ l.name }}</td>
                  <td class="mono">{{ fmtKm(l.distKm) }}</td>
                  <td class="mono">{{ fmtSnr(l.snr) }}</td>
                  <td :class="clearanceClass(l.clearance)">{{ clearanceLabel(l.clearance) }}</td>
                </tr>
              </tbody>
            </table>
          </li>
        </ol>

        <p v-if="unresolvedIslands.length || unresolvedCuts.length" class="unresolved">
          Sans solution dans la vue :
          <template v-for="i in unresolvedIslands" :key="i.names.join()"> îlot {{ names(i.names) }} ·</template>
          <template v-for="c in unresolvedCuts" :key="c.key"> {{ c.name }} ({{ c.after }} dépendants) ·</template>
          aucun point haut n'atteint les deux côtés.
        </p>

        <p class="caveat">
          {{ r.candidates }} points hauts évalués. Relief nu (sans bâtiments ni arbres), SNR estimé par la perte en
          espace libre et le pire obstacle (référence {{ SNR_REF_DB }} dB, non calée sur les mesures) : une piste pour
          un repérage sur place, pas un plan. Les {{ r.unlinked }} nœuds sans aucun lien sont ignorés : l'absence de lien
          ne prouve pas l'isolement.
        </p>
      </template>
    </section>
  </div>
</template>

<style scoped>
.siting {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
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

.toggle.has {
  color: #b7791f;
}

.toggle svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
}

.panel {
  position: absolute;
  top: 0;
  right: 37px;
  width: 320px;
  max-height: min(70vh, 620px);
  overflow-y: auto;
  padding: 10px 12px 12px;
  background: color-mix(in srgb, var(--surface-1) 97%, transparent);
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
  font-size: 12px;
  font-weight: 600;
}

.x {
  background: none;
  border: 0;
  color: var(--text-muted);
  cursor: pointer;
}

.lead,
.caveat,
.unresolved {
  margin: 6px 0 0;
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-secondary);
}

.caveat {
  color: var(--text-muted);
  font-size: 10.5px;
}

.controls {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.controls label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text-secondary);
}

.controls input {
  width: 48px;
  padding: 2px 4px;
  background: var(--surface-0);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-primary);
  font: inherit;
}

.run {
  padding: 4px 10px;
  background: var(--accent);
  border: 0;
  border-radius: 4px;
  color: #fff;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.run:disabled {
  opacity: 0.6;
  cursor: wait;
}

.link {
  background: none;
  border: 0;
  padding: 0;
  color: var(--text-secondary);
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}

.progress,
.stale,
.ko,
.summary {
  margin: 8px 0 0;
  font-size: 11.5px;
}

.progress,
.stale {
  color: var(--text-secondary);
}

.ko {
  color: var(--status-critical);
}

.sites {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}

.site {
  display: grid;
  grid-template-columns: 20px 1fr auto;
  align-items: start;
  gap: 8px;
  width: 100%;
  padding: 6px;
  background: var(--surface-2);
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--text-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

li.open .site {
  border-color: #fab219;
}

.n {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: 2px dashed #fab219;
  border-radius: 50%;
  outline: 1px solid #1a1a19;
  font-size: 10.5px;
  font-weight: 700;
}

.what {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-wrap: anywhere;
}

.alt {
  color: var(--text-muted);
}

.mono {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.reach {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--text-secondary);
}

.links {
  width: 100%;
  margin: 4px 0 2px;
  border-collapse: collapse;
  font-size: 11px;
}

.links th {
  padding: 2px 4px;
  font-weight: 500;
  text-align: left;
  color: var(--text-muted);
}

.links td {
  padding: 2px 4px;
  border-top: 1px solid var(--border);
  overflow-wrap: anywhere;
}

.clear {
  color: var(--status-good);
}

.blocked {
  color: var(--status-critical);
}

@media (max-width: 760px) {
  .panel {
    position: fixed;
    top: auto;
    right: 12px;
    bottom: 12px;
    left: 12px;
    width: auto;
    max-height: 55vh;
    z-index: 5;
  }
}
</style>
