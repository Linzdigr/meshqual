<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { RESP_ERR } from '@/companion/protocol'
import { encodeLogin, encodeLogout, parseLoginResult, parseRequestSent, samePrefix, type NodeStats } from '@/companion/remote'
import { ensureContact, getParam, requestStatus, runCli } from '@/companion/nodeCli'
import { useTraceStore } from '@/stores/trace'
import { formatDuration } from '@/utils/duration'

const props = defineProps<{
  nodeKey: string
  name: string
  nodeType: string
  /** The node's position on the map, offered for its lat/lon settings. */
  position?: [number, number]
}>()

const companion = useTraceStore()

const password = ref('')
const state = ref<'idle' | 'busy' | 'open' | 'error'>('idle')
const error = ref<string | null>(null)
const admin = ref(false)
const viaFlood = ref(false)
const tab = ref<'status' | 'settings'>('status')

// A new node closes the session view; the companion keeps its own state.
watch(
  () => props.nodeKey,
  () => {
    state.value = 'idle'
    error.value = null
    stats.value = null
    Object.keys(values).forEach((k) => delete values[k])
    loaded.clear()
  },
)

async function open() {
  state.value = 'busy'
  error.value = null
  try {
    await ensureContact(companion, props.nodeKey, props.nodeType, props.name)
    const sentFrame = await companion.exchange(encodeLogin(props.nodeKey, password.value), (f) => f[0] === 0x06 || f[0] === RESP_ERR)
    password.value = ''
    const sent = sentFrame && parseRequestSent(sentFrame)
    if (!sent) throw new Error('connexion refusée par le compagnon')
    viaFlood.value = sent.flood
    const f = await companion.waitFor((x) => {
      const r = parseLoginResult(x)
      return !!r && samePrefix(r.prefix, props.nodeKey)
    }, sent.timeoutMs + 8_000)
    const r = f && parseLoginResult(f)
    if (!r) throw new Error('pas de réponse du nœud')
    if (!r.ok) throw new Error('mot de passe refusé')
    admin.value = r.admin
    state.value = 'open'
    void refreshStats()
  } catch (e) {
    state.value = 'error'
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function close() {
  await companion.exchange(encodeLogout(props.nodeKey), (f) => f[0] === 0 || f[0] === RESP_ERR).catch(() => null)
  state.value = 'idle'
}

// ---- Status --------------------------------------------------------------

const stats = ref<NodeStats | null>(null)
const statsAt = ref<number | null>(null)
const statsBusy = ref(false)
const statsError = ref<string | null>(null)

async function refreshStats() {
  statsBusy.value = true
  statsError.value = null
  try {
    stats.value = await requestStatus(companion, props.nodeKey)
    statsAt.value = Date.now()
  } catch (e) {
    statsError.value = e instanceof Error ? e.message : String(e)
  } finally {
    statsBusy.value = false
  }
}

/** Li-ion: 3.0 V empty to 4.2 V full, roughly linear in between. */
const battPct = (mv: number) => Math.round(Math.min(100, Math.max(0, ((mv - 3000) / 1200) * 100)))
const fmtTime = (s: number) => formatDuration(s)

const statTiles = computed(() => {
  const s = stats.value
  if (!s) return []
  return [
    { label: 'Batterie', value: `${(s.battMv / 1000).toFixed(2)} V`, hint: `≈ ${battPct(s.battMv)} %` },
    { label: 'En service depuis', value: fmtTime(s.upTimeSec) },
    { label: "File d'émission", value: String(s.txQueue), hint: 'paquets en attente' },
    { label: 'Bruit de fond', value: `${s.noiseFloor} dBm` },
    {
      label: 'Dernier reçu',
      value: s.lastSnr !== undefined ? `${s.lastSnr.toFixed(1)} dB` : '—',
      hint: `RSSI ${s.lastRssi} dBm`,
    },
    {
      label: "Temps d'antenne",
      value: `TX ${fmtTime(s.airTimeSec)}`,
      hint: s.rxAirTimeSec !== undefined ? `RX ${fmtTime(s.rxAirTimeSec)}` : undefined,
    },
    { label: 'Reçus', value: String(s.recv), hint: `flood ${s.recvFlood} · direct ${s.recvDirect}` },
    { label: 'Émis', value: String(s.sent), hint: `flood ${s.sentFlood} · direct ${s.sentDirect}` },
    {
      label: 'Doublons / erreurs',
      value: `${(s.dupsFlood ?? 0) + (s.dupsDirect ?? 0)} / ${s.recvErrors ?? s.errEvents ?? 0}`,
    },
  ]
})

// ---- Settings ------------------------------------------------------------

interface Field {
  name: string
  label: string
  hint?: string
  options?: string[]
  /** Reads differently from `get <name>` / `set <name> <value>`. */
  get?: string
  set?: (v: string) => string
  parse?: (reply: string) => string
  /** An error message for a bad value, or null. */
  validate?: (v: string) => string | null
  /** Asked before applying: the change can cut the node off or break rules. */
  confirm?: (v: string) => string
  /** Shown, not editable. */
  readOnly?: boolean
}

interface Section {
  id: string
  title: string
  fields: Field[]
}

const sections: Section[] = [
  {
    id: 'identity',
    title: 'Identité',
    fields: [
      { name: 'name', label: 'Nom' },
      { name: 'lat', label: 'Latitude' },
      { name: 'lon', label: 'Longitude' },
    ],
  },
  {
    id: 'relay',
    title: 'Relais',
    fields: [
      { name: 'repeat', label: 'Relais', options: ['on', 'off'] },
      { name: 'path.hash.mode', label: 'Hash de chemin', options: ['0', '1', '2'], hint: '0 = 1 octet, 1 = 2 octets, 2 = 3 octets' },
      { name: 'flood.max', label: 'Sauts flood max' },
      { name: 'txdelay', label: 'Délai émission flood', hint: 'facteur' },
      { name: 'direct.txdelay', label: 'Délai émission direct', hint: 'facteur' },
      { name: 'rxdelay', label: 'Délai réception', hint: 'base' },
      { name: 'loop.detect', label: 'Détection de boucles', options: ['off', 'minimal', 'moderate', 'strict'] },
    ],
  },
  {
    id: 'radio',
    title: 'Radio',
    fields: [
      {
        name: 'tx',
        label: "Puissance d'émission",
        hint: "dBm; plafonnée selon modèle (22 dBm sur un SX1262)",
        validate: (v) => (/^-?\d+$/.test(v) && +v >= -9 && +v <= 30 ? null : 'un entier entre -9 et 30 dBm'),
        confirm: (v) => `Régler la puissance d'émission à ${v} dBm ? Une puissance trop basse peut couper le nœud du mesh.`,
      },
      {
        name: 'radio',
        label: 'Paramètres radio',
        hint: 'fréquence, largeur de bande, SF, CR : modifiables seulement en local (USB)',
        readOnly: true,
      },
    ],
  },
  {
    id: 'adverts',
    title: 'Annonces et région',
    fields: [
      { name: 'advert.interval', label: 'Annonce locale', hint: 'minutes, 0 = jamais' },
      { name: 'flood.advert.interval', label: 'Annonce flood', hint: 'heures, 0 = jamais' },
      {
        name: 'region.default',
        label: 'Région par défaut',
        hint: 'créée si besoin et enregistrée',
        get: 'region default',
        set: (v) => `region default ${v}`,
        parse: (r) => r.replace(/^\s*default scope is( now)?\s*/i, '').trim(),
      },
    ],
  },
]

const values = reactive<Record<string, string>>({})
const drafts = reactive<Record<string, string>>({})
const results = reactive<Record<string, { ok: boolean; text: string }>>({})
const busyField = ref<string | null>(null)
const loaded = new Set<string>()
const loading = ref<string | null>(null)

async function readField(f: Field) {
  const raw = f.get ? await runCli(companion, props.nodeKey, f.get) : await getParam(companion, props.nodeKey, f.name)
  values[f.name] = f.parse ? f.parse(raw) : raw
  drafts[f.name] = values[f.name]!
}

/** Loads a section's values the first time it is opened, one command at a time. */
async function onToggle(s: Section, e: Event) {
  if (!(e.target as HTMLDetailsElement).open || loaded.has(s.id)) return
  loaded.add(s.id)
  loading.value = s.id
  try {
    for (const f of s.fields) {
      try {
        await readField(f)
      } catch (err) {
        results[f.name] = { ok: false, text: err instanceof Error ? err.message : String(err) }
      }
    }
  } finally {
    loading.value = null
  }
}

async function apply(f: Field) {
  const v = (drafts[f.name] ?? '').trim()
  if (!v || v === values[f.name] || f.readOnly) return
  const bad = f.validate?.(v)
  if (bad) {
    results[f.name] = { ok: false, text: bad }
    return
  }
  if (f.confirm && !window.confirm(f.confirm(v))) return
  busyField.value = f.name
  try {
    const reply = await runCli(companion, props.nodeKey, f.set ? f.set(v) : `set ${f.name} ${v}`)
    const ok = !/^\s*(err|error|unknown)/i.test(reply)
    results[f.name] = { ok, text: reply.trim() || 'OK' }
    await readField(f) // confirm what the node now holds
  } catch (err) {
    results[f.name] = { ok: false, text: err instanceof Error ? err.message : String(err) }
  } finally {
    busyField.value = null
  }
}

function useMapPosition() {
  if (!props.position) return
  drafts.lon = props.position[0].toFixed(5)
  drafts.lat = props.position[1].toFixed(5)
}

const actionReply = ref<string | null>(null)
async function sendAdvert() {
  actionReply.value = '…'
  try {
    actionReply.value = (await runCli(companion, props.nodeKey, 'advert')).trim() || 'OK'
  } catch (err) {
    actionReply.value = err instanceof Error ? err.message : String(err)
  }
}

/** One-click fixes offered from the node panel's ⚠ (see NodePanel). */
async function fix(command: string): Promise<string> {
  return (await runCli(companion, props.nodeKey, command)).trim() || 'OK'
}

defineExpose({ fix, isAdmin: computed(() => state.value === 'open' && admin.value) })
</script>

<template>
  <section class="admin">
    <h3>Gérer via le compagnon</h3>

    <form v-if="state !== 'open'" class="login" @submit.prevent="open">
      <input
        v-model="password"
        type="password"
        autocomplete="off"
        placeholder="Mot de passe du nœud"
        aria-label="Mot de passe du nœud"
        :disabled="state === 'busy'"
      />
      <button type="submit" class="btn" :disabled="state === 'busy'">
        {{ state === 'busy' ? 'Connexion…' : 'Se connecter' }}
      </button>
      <p v-if="error" class="ko">{{ error }}</p>
      <p class="note">Le mot de passe va du navigateur au compagnon, puis au nœud. Il n'est pas conservé.</p>
    </form>

    <template v-else>
      <p class="session">
        <span class="dot" aria-hidden="true" />
        {{ admin ? 'Administrateur' : 'Lecture seule' }}
        <span class="note">· {{ viaFlood ? 'chemin inconnu, envoi flood' : 'chemin direct' }}</span>
        <button type="button" class="link" @click="close">Fermer la session</button>
      </p>

      <div class="tabs" role="tablist">
        <button type="button" role="tab" :aria-selected="tab === 'status'" :class="{ on: tab === 'status' }" @click="tab = 'status'">
          État
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="tab === 'settings'"
          :class="{ on: tab === 'settings' }"
          :disabled="!admin"
          :title="admin ? undefined : 'Réservé à une session administrateur'"
          @click="tab = 'settings'"
        >
          Réglages
        </button>
      </div>

      <div v-if="tab === 'status'" class="status">
        <div class="row">
          <button type="button" class="btn" :disabled="statsBusy" @click="refreshStats">
            {{ statsBusy ? 'Demande…' : 'Actualiser' }}
          </button>
          <span v-if="statsAt" class="note">il y a {{ formatDuration(Math.round((Date.now() - statsAt) / 1000)) }}</span>
        </div>
        <p v-if="statsError" class="ko">{{ statsError }}</p>
        <div class="tiles">
          <div v-for="t in statTiles" :key="t.label" class="tile">
            <span class="t-label">{{ t.label }}</span>
            <span class="t-value mono">{{ t.value }}</span>
            <span v-if="t.hint" class="t-hint">{{ t.hint }}</span>
          </div>
        </div>
      </div>

      <div v-else class="settings">
        <p class="note">Chaque section lit ses valeurs à l'ouverture, une commande à la fois à travers le mesh.</p>
        <details v-for="s in sections" :key="s.id" @toggle="onToggle(s, $event)">
          <summary>
            {{ s.title }}
            <span v-if="loading === s.id" class="note">lecture…</span>
          </summary>
          <div v-for="f in s.fields" :key="f.name" class="field">
            <label :for="`f-${f.name}`">{{ f.label }}</label>
            <select v-if="f.options" :id="`f-${f.name}`" v-model="drafts[f.name]" :disabled="values[f.name] === undefined">
              <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
            </select>
            <span v-else-if="f.readOnly" :id="`f-${f.name}`" class="mono ro">{{ values[f.name] ?? '…' }}</span>
            <input v-else :id="`f-${f.name}`" v-model="drafts[f.name]" :disabled="values[f.name] === undefined" />
            <span v-if="f.readOnly" />
            <button
              v-else
              type="button"
              class="btn small"
              :disabled="busyField !== null || values[f.name] === undefined || (drafts[f.name] ?? '').trim() === values[f.name]"
              @click="apply(f)"
            >
              {{ busyField === f.name ? '…' : 'Appliquer' }}
            </button>
            <small v-if="f.hint" class="hint">{{ f.hint }}</small>
            <small v-if="results[f.name]" class="reply" :class="{ ko: !results[f.name]!.ok }">{{ results[f.name]!.text }}</small>
          </div>
          <div v-if="s.id === 'identity' && position" class="row">
            <button type="button" class="link" @click="useMapPosition">Reprendre la position de la carte</button>
          </div>
          <div v-if="s.id === 'adverts'" class="row">
            <button type="button" class="btn small" @click="sendAdvert">Envoyer une annonce maintenant</button>
            <span v-if="actionReply" class="note">{{ actionReply }}</span>
          </div>
        </details>
      </div>
    </template>
  </section>
</template>

<style scoped>
.admin {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}

h3 {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.login {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.login input {
  flex: 1;
  min-width: 140px;
}

input,
select {
  padding: 3px 6px;
  background: var(--surface-0);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 12px;
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

.btn.small {
  padding: 2px 8px;
  font-size: 11px;
}

.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
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

p {
  margin: 0;
}

.note,
.hint {
  font-size: 11px;
  color: var(--text-muted);
}

.ko {
  font-size: 11.5px;
  color: var(--status-critical);
}

.session {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--status-good);
}

.tabs {
  display: flex;
  gap: 2px;
  padding: 2px;
  background: var(--surface-2);
  border-radius: 5px;
}

.tabs button {
  flex: 1;
  padding: 4px;
  background: none;
  border: 0;
  border-radius: 4px;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
}

.tabs button.on {
  background: var(--surface-0);
  color: var(--text-primary);
}

.tabs button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 6px;
  margin-top: 6px;
}

.tile {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  background: var(--surface-2);
  border-radius: 4px;
}

.t-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
}

.t-value {
  font-size: 14px;
}

.t-hint {
  font-size: 10.5px;
  color: var(--text-muted);
}

.settings {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

details {
  padding: 6px 8px;
  background: var(--surface-2);
  border-radius: 4px;
}

summary {
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.field {
  display: grid;
  grid-template-columns: 130px 1fr auto;
  gap: 2px 6px;
  align-items: center;
  margin-top: 6px;
  font-size: 12px;
}

.field .hint,
.field .reply {
  grid-column: 2 / 4;
  font-size: 10.5px;
}

.reply {
  color: var(--status-good);
}

.ro {
  font-size: 12px;
}

.mono {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}
</style>
