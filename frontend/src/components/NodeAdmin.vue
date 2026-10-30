<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { RESP_ERR } from '@/companion/protocol'
import { encodeLogin, encodeLogout, parseLoginResult, parseRequestSent, samePrefix, type NodeStats } from '@/companion/remote'
import { ensureContact, getParam, NoReply, requestStatus, resetPath, runCli, withFloodRetry } from '@/companion/nodeCli'
import { useTraceStore } from '@/stores/trace'
import { describeArea, frenchArea, recommendedSteps, type Step } from '@/companion/recommend'
import RecommendedSetup from './RecommendedSetup.vue'
import { formatDuration } from '@/utils/duration'

const props = defineProps<{
  nodeKey: string
  name: string
  nodeType: string
  /** The node's position on the map, offered for its lat/lon settings. */
  position?: [number, number]
  /** An observer: its MQTT settings are offered. */
  observer?: boolean
  /** Path hash width from its adverts, for the recommended settings. */
  pathHashSize?: number
}>()

const companion = useTraceStore()

const password = ref('')
const state = ref<'idle' | 'busy' | 'open' | 'error'>('idle')
const error = ref<string | null>(null)
const admin = ref(false)
/** How requests reach the node: flood, a path the companion knew, one from a trace, or flood again after a lost path. */
const route = ref<'flood' | 'direct' | 'trace' | 'reset'>('flood')
const ROUTE_LABEL = {
  flood: 'connexion en flood, chemin appris au retour',
  direct: 'chemin direct',
  trace: "chemin direct, celui d'une trace revenue",
  reset: 'chemin perdu, renvoi en flood',
} as const
const onPathReset = () => (route.value = 'reset')

/** Every request to the node goes out flood again once if its stored path no longer answers. */
const cli = (command: string) => withFloodRetry(companion, props.nodeKey, () => runCli(companion, props.nodeKey, command), onPathReset)
const param = (name: string) => withFloodRetry(companion, props.nodeKey, () => getParam(companion, props.nodeKey, name), onPathReset)
const tab = ref<'status' | 'settings' | 'cli'>('status')

// A new node closes the session view; the companion keeps its own state.
watch(
  () => props.nodeKey,
  () => {
    state.value = 'idle'
    error.value = null
    stats.value = null
    Object.keys(values).forEach((k) => delete values[k])
    loaded.clear()
    cliLog.value = []
    mqttSlot.value = 1
  },
)

async function login(pwd: string) {
  const sentFrame = await companion.exchange(encodeLogin(props.nodeKey, pwd), (f) => f[0] === 0x06 || f[0] === RESP_ERR)
  const sent = sentFrame && parseRequestSent(sentFrame)
  if (!sent) throw new Error('connexion refusée par le compagnon')
  if (sent.flood) route.value = route.value === 'reset' ? 'reset' : 'flood'
  else if (route.value === 'flood') route.value = 'direct'
  const f = await companion.waitFor((x) => {
    const r = parseLoginResult(x)
    return !!r && samePrefix(r.prefix, props.nodeKey)
  }, sent.timeoutMs + 8_000)
  const r = f && parseLoginResult(f)
  if (!r) throw new NoReply('pas de réponse du nœud', !sent.flood)
  return r
}

async function open() {
  state.value = 'busy'
  error.value = null
  // Kept only for this attempt and its flood retry.
  const pwd = password.value
  password.value = ''
  try {
    const seeded = await ensureContact(companion, props.nodeKey, props.nodeType, props.name, companion.routeTo(props.nodeKey))
    route.value = seeded ? 'trace' : 'flood'
    const r = await withFloodRetry(companion, props.nodeKey, () => login(pwd), onPathReset)
    if (!r.ok) throw new Error('mot de passe refusé')
    admin.value = r.admin
    state.value = 'open'
    void refreshStats()
  } catch (e) {
    state.value = 'error'
    error.value = e instanceof Error ? e.message : String(e)
  }
}

/** Drops the companion's stored path to the node: the next request floods and learns a fresh one. */
async function forgetPath() {
  try {
    await resetPath(companion, props.nodeKey)
    route.value = 'flood'
  } catch (e) {
    statsError.value = e instanceof Error ? e.message : String(e)
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
    stats.value = await withFloodRetry(companion, props.nodeKey, () => requestStatus(companion, props.nodeKey), onPathReset)
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
  /** Readable labels for the options. */
  labels?: Record<string, string>
  /** Write-only: the node only says whether it is set (passwords). */
  secret?: boolean
}

interface Section {
  id: string
  title: string
  fields: Field[]
  /** One-shot commands offered under the fields. */
  actions?: { label: string; command: string; confirm?: string }[]
  hint?: string
}

const ON_OFF = ['on', 'off']
/** Firmware without the feature answers with an error or "??": show it as is. */
const raw = (r: string) => r.replace(/^>\s?/, '').trim()

/** Observer firmware: up to 6 broker slots, read one at a time. */
const mqttSlot = ref(1)

const staticSections: Section[] = [
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
    actions: [{ label: 'Envoyer une annonce maintenant', command: 'advert' }],
  },
  {
    id: 'gps',
    title: 'GPS',
    hint: 'Firmwares compilés avec GPS seulement ; les autres répondent par une erreur.',
    fields: [
      { name: 'gps.status', label: 'État', get: 'gps', parse: raw, readOnly: true },
      {
        name: 'gps.enabled',
        label: 'GPS',
        options: ON_OFF,
        get: 'gps',
        parse: (r) => (/\bactive\b/.test(r) ? 'on' : /deactivated|^\s*>?\s*off/i.test(r) ? 'off' : raw(r)),
        set: (v) => `gps ${v}`,
      },
      {
        name: 'gps.advert',
        label: 'Position annoncée',
        options: ['none', 'share', 'prefs'],
        labels: { none: 'aucune', share: 'GPS en direct', prefs: 'position enregistrée' },
        get: 'gps advert',
        parse: raw,
        set: (v) => `gps advert ${v}`,
      },
    ],
    actions: [
      { label: 'Enregistrer la position GPS comme position du nœud', command: 'gps setloc' },
      { label: "Régler l'horloge sur le GPS", command: 'gps sync' },
    ],
  },
  {
    id: 'mqtt',
    title: 'MQTT',
    hint: 'Firmware observateur seulement (MQTT bridge).',
    fields: [
      { name: 'mqtt.status', label: 'Connexions', readOnly: true, parse: raw },
      { name: 'mqtt.stats', label: 'Statistiques', readOnly: true, parse: raw },
      { name: 'link.status', label: 'Réseau', readOnly: true, parse: raw },
      { name: 'wifi.ssid', label: 'Wi-Fi', readOnly: true, parse: raw },
      {
        name: 'mqtt.iata',
        label: 'Code région (IATA)',
        validate: (v) => (/^[A-Za-z0-9]{3}$/.test(v) && v.toUpperCase() !== 'XXX' ? null : '3 lettres ou chiffres, pas XXX'),
      },
      { name: 'mqtt.origin', label: 'Nom publié' },
      { name: 'mqtt.packets', label: 'Publier les paquets', options: ON_OFF },
      { name: 'mqtt.rx', label: 'Paquets reçus', options: ON_OFF },
      { name: 'mqtt.tx', label: 'Paquets émis', options: ['on', 'off', 'advert'], labels: { advert: 'annonces seulement' } },
      { name: 'mqtt.raw', label: 'Trames brutes', options: ON_OFF },
    ],
  },
]

const slotSection = computed<Section>(() => {
  const n = mqttSlot.value
  const k = (x: string) => `mqtt${n}.${x}`
  return {
    id: 'mqtt-slot',
    title: 'MQTT – emplacements',
    fields: [
      { name: k('diag'), label: 'Diagnostic', readOnly: true, parse: raw },
      { name: k('preset'), label: 'Broker (preset)', hint: "'none' désactive, 'custom' pour un broker à soi" },
      { name: k('server'), label: 'Serveur' },
      { name: k('port'), label: 'Port', validate: (v) => (/^\d+$/.test(v) && +v > 0 && +v < 65536 ? null : 'un port de 1 à 65535') },
      { name: k('username'), label: 'Utilisateur' },
      { name: k('password'), label: 'Mot de passe', secret: true, hint: 'en écriture seule ; le nœud dit seulement s’il est défini' },
      { name: k('topic'), label: 'Topic', hint: 'vide = meshcore/{iata}/{device}/{type}' },
    ],
  }
})

// MQTT settings only exist on observer firmware.
const sections = computed(() =>
  props.observer ? [...staticSections, slotSection.value] : staticSections.filter((s) => s.id !== 'mqtt'),
)

const values = reactive<Record<string, string>>({})
const drafts = reactive<Record<string, string>>({})
const results = reactive<Record<string, { ok: boolean; text: string }>>({})
const busyField = ref<string | null>(null)
const loaded = new Set<string>()
const loading = ref<string | null>(null)

/** Several fields can share one command (gps): one read serves them all. */
async function readField(f: Field, cache?: Map<string, string>) {
  const cmd = f.get ?? `get ${f.name}`
  let reply = cache?.get(cmd)
  if (reply === undefined) {
    reply = f.get ? await cli(cmd) : await param(f.name)
    cache?.set(cmd, reply)
  }
  values[f.name] = f.parse ? f.parse(reply) : reply
  drafts[f.name] = f.secret ? '' : values[f.name]!
}

/** Loads a section's values the first time it is opened, one command at a time. */
async function onToggle(s: Section, e: Event) {
  if (!(e.target as HTMLDetailsElement).open || loaded.has(s.id)) return
  await loadSection(s)
}

async function loadSection(s: Section) {
  loaded.add(s.id)
  const cache = new Map<string, string>()
  loading.value = s.id
  try {
    for (const f of s.fields) {
      try {
        await readField(f, cache)
      } catch (err) {
        results[f.name] = { ok: false, text: err instanceof Error ? err.message : String(err) }
      }
    }
  } finally {
    loading.value = null
  }
}

watch(mqttSlot, () => {
  if (loaded.has('mqtt-slot')) void loadSection(slotSection.value)
})

const canApply = (f: Field) => {
  const v = (drafts[f.name] ?? '').trim()
  return busyField.value === null && values[f.name] !== undefined && v !== '' && (f.secret || v !== values[f.name])
}

async function apply(f: Field) {
  const v = (drafts[f.name] ?? '').trim()
  if (!canApply(f) || f.readOnly) return
  const bad = f.validate?.(v)
  if (bad) {
    results[f.name] = { ok: false, text: bad }
    return
  }
  if (f.confirm && !window.confirm(f.confirm(v))) return
  busyField.value = f.name
  try {
    const reply = await cli(f.set ? f.set(v) : `set ${f.name} ${v}`)
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

const actionReplies = reactive<Record<string, string>>({})
async function runAction(a: { command: string; confirm?: string }) {
  if (a.confirm && !window.confirm(a.confirm)) return
  actionReplies[a.command] = '…'
  try {
    actionReplies[a.command] = (await cli(a.command)).trim() || 'OK'
  } catch (err) {
    actionReplies[a.command] = err instanceof Error ? err.message : String(err)
  }
}

// ---- CLI -----------------------------------------------------------------

const cliInput = ref('')
const cliBusy = ref(false)
const cliLog = ref<{ command: string; reply: string; ok: boolean; at: number }[]>([])
/** The command on its way, shown at the end of the log until it is answered. */
const cliPending = ref<string | null>(null)
const cliLogEl = ref<HTMLElement | null>(null)
let historyIndex = -1

// Like a terminal: the latest output stays in view.
watch(
  () => [cliLog.value.length, cliPending.value],
  async () => {
    await nextTick()
    const el = cliLogEl.value
    if (el) el.scrollTop = el.scrollHeight
  },
)

async function sendCli() {
  const command = cliInput.value.trim()
  if (!command || cliBusy.value) return
  cliBusy.value = true
  cliPending.value = command
  cliInput.value = ''
  historyIndex = -1
  try {
    const reply = await cli(command)
    cliLog.value = [...cliLog.value, { command, reply: reply.trim() || 'OK', ok: true, at: Date.now() }]
  } catch (err) {
    cliLog.value = [
      ...cliLog.value,
      { command, reply: err instanceof Error ? err.message : String(err), ok: false, at: Date.now() },
    ]
  } finally {
    cliPending.value = null
    cliBusy.value = false
  }
}

/** Up and down walk back through the commands already sent. */
function cliHistory(step: 1 | -1) {
  const past = cliLog.value.map((l) => l.command)
  if (!past.length) return
  historyIndex = Math.max(-1, Math.min(past.length - 1, historyIndex + step))
  cliInput.value = historyIndex < 0 ? '' : past[past.length - 1 - historyIndex]!
}

/** One-click fixes offered from the node panel's ⚠ (see NodePanel). */
async function fix(command: string): Promise<string> {
  return (await cli(command)).trim() || 'OK'
}

// ---- Recommended settings ----------------------------------------------

const setup = ref<{ steps: Step[]; area: string | null } | null>(null)
const locating = ref(false)

/**
 * Builds the script, with the region tree for where the node stands (its
 * department and region, from geo.api.gouv.fr), then shows it for review.
 */
async function openSetup() {
  locating.value = true
  const [lon, lat] = props.position ?? []
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 5_000)
  const area = lat !== undefined && lon !== undefined ? await frenchArea(lat, lon, ac.signal) : null
  clearTimeout(timer)
  locating.value = false
  setup.value = { steps: recommendedSteps(area), area: area ? describeArea(area) : null }
}

const runOne = cli

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
        <span class="note">· {{ ROUTE_LABEL[route] }}</span>
        <button
          type="button"
          class="link"
          title="Le compagnon oublie le chemin stocké : la prochaine requête part en flood et en apprend un nouveau"
          @click="forgetPath"
        >
          Oublier le chemin
        </button>
        <button type="button" class="link" @click="close">Fermer la session</button>
      </p>

      <button v-if="admin" type="button" class="btn recommend" :disabled="locating" @click="openSetup">
        {{ locating ? 'Localisation du nœud…' : 'Appliquer les réglages recommandés…' }}
      </button>
      <RecommendedSetup
        v-if="setup"
        :node-name="name"
        :steps="setup.steps"
        :area="setup.area"
        :run="runOne"
        @close="setup = null"
      />

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
        <button
          type="button"
          role="tab"
          :aria-selected="tab === 'cli'"
          :class="{ on: tab === 'cli' }"
          :disabled="!admin"
          :title="admin ? undefined : 'Réservé à une session administrateur'"
          @click="tab = 'cli'"
        >
          CLI
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

      <div v-else-if="tab === 'cli'" class="cli">
        <ol v-if="cliLog.length || cliPending" ref="cliLogEl" class="cli-log mono">
          <li v-for="(l, i) in cliLog" :key="i">
            <span class="cmd">› {{ l.command }}</span>
            <pre :class="{ ko: !l.ok }">{{ l.reply }}</pre>
          </li>
          <li v-if="cliPending">
            <span class="cmd">› {{ cliPending }}</span>
            <pre class="waiting">en attente de la réponse…</pre>
          </li>
        </ol>
        <p v-else class="note">Commandes CLI du firmware, envoyées une à une à travers le mesh. ↑ et ↓ rappellent les précédentes.</p>
        <form class="cli-form" @submit.prevent="sendCli">
          <input
            v-model="cliInput"
            class="mono"
            placeholder="ex. get repeat, neighbors, ver"
            aria-label="Commande CLI"
            autocomplete="off"
            spellcheck="false"
            @keydown.up.prevent="cliHistory(1)"
            @keydown.down.prevent="cliHistory(-1)"
          />
          <button type="submit" class="btn" :disabled="cliBusy || !cliInput.trim()">{{ cliBusy ? '…' : 'Envoyer' }}</button>
        </form>
      </div>

      <div v-else class="settings">
        <p class="note">Chaque section lit ses valeurs à l'ouverture, une commande à la fois à travers le mesh.</p>
        <details v-for="s in sections" :key="s.id" @toggle="onToggle(s, $event)">
          <summary>
            {{ s.title }}
            <span v-if="loading === s.id" class="note">lecture…</span>
          </summary>
          <p v-if="s.hint" class="note">{{ s.hint }}</p>
          <label v-if="s.id === 'mqtt-slot'" class="slot">
            Emplacement
            <select v-model.number="mqttSlot" :disabled="loading !== null">
              <option v-for="n in 6" :key="n" :value="n">{{ n }}</option>
            </select>
          </label>
          <div v-for="f in s.fields" :key="f.name" class="field">
            <label :for="`f-${f.name}`">{{ f.label }}</label>
            <select v-if="f.options" :id="`f-${f.name}`" v-model="drafts[f.name]" :disabled="values[f.name] === undefined">
              <option v-for="o in f.options" :key="o" :value="o">{{ f.labels?.[o] ?? o }}</option>
            </select>
            <span v-else-if="f.readOnly" :id="`f-${f.name}`" class="mono ro">{{ values[f.name] ?? '…' }}</span>
            <input
              v-else
              :id="`f-${f.name}`"
              v-model="drafts[f.name]"
              :type="f.secret ? 'password' : 'text'"
              :placeholder="f.secret ? values[f.name] : undefined"
              autocomplete="off"
              :disabled="values[f.name] === undefined"
            />
            <span v-if="f.readOnly" />
            <button
              v-else
              type="button"
              class="btn small"
              :disabled="!canApply(f)"
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
          <div v-for="a in s.actions ?? []" :key="a.command" class="row">
            <button type="button" class="btn small" :disabled="busyField !== null" @click="runAction(a)">{{ a.label }}</button>
            <span v-if="actionReplies[a.command]" class="note">{{ actionReplies[a.command] }}</span>
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
  min-width: 0;
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

.recommend {
  align-self: flex-start;
}

.ro {
  font-size: 11.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.slot {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  font-size: 12px;
}

.cli {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.cli-log {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 260px;
  margin: 0;
  padding: 8px;
  overflow-y: auto;
  list-style: none;
  /* A terminal: black whatever the theme, so its colours are fixed too. */
  background: #000;
  border-radius: 4px;
  font-size: 11.5px;
  color: #e6e6e6;
  color-scheme: dark; /* dark scrollbar */
}

/* Flex items keep their content's width by default: a long reply (a key, a
   status line with no spaces) would push past the panel instead of wrapping. */
.cli-log li {
  min-width: 0;
}

.cli-log .cmd {
  color: #7db7ff;
  overflow-wrap: anywhere;
}

.cli-log pre {
  margin: 2px 0 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  color: #e6e6e6;
}

.cli-log pre.waiting {
  color: #8a8a8a;
}

.cli-log pre.ko {
  color: #ff7b7b;
}

.cli-form {
  display: flex;
  gap: 6px;
}

.cli-form input {
  flex: 1;
}

.mono {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}
</style>
