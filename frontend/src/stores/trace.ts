import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import {
  encodeAppStart,
  encodeDiscover,
  encodeTrace,
  parseDiscoverResponse,
  parseSelfInfo,
  parseSent,
  parseTraceData,
  RESP_ERR,
  RESP_OK,
  roundTrip,
  type DiscoveredRepeater,
  type SelfInfo,
} from '@/companion/protocol'
import { planTraces, type PlannedTrace } from '@/companion/planner'
import {
  Cancelled,
  connect as openTransport,
  supported,
  type Transport,
  type TransportKind,
} from '@/companion/transport'
import { useMeshStore } from '@/stores/mesh'

/** One radio hop of a trace, in the direction the trace travelled. */
export interface TraceHop {
  from: string
  to: string
  /** SNR the receiving end measured, in dB; absent on the outbound legs. */
  snr?: number
}

export type TraceResult =
  | { ok: true; hops: TraceHop[]; at: number }
  | { ok: false; reason: string; at: number }

/** A trace of the automatic mode, with how it went. */
export interface CampaignItem extends PlannedTrace {
  status: 'pending' | 'running' | 'ok' | 'ko'
  result?: TraceResult
}

const REPLY_TIMEOUT_MS = 5_000
/** A trace path holds at most 64 bytes of hashes: 32 hops at 2 bytes. */
export const MAX_TRACE_HOPS = 32
/** Slack on top of the firmware's own round-trip estimate. */
const TRACE_MARGIN_MS = 4_000
/** Repeaters answer a discovery after a random delay (a few seconds, widened x4). */
export const DISCOVER_WINDOW_MS = 10_000
/** Quiet time between two automatic traces: the channel is shared. */
const CAMPAIGN_GAP_MS = 6_000
/** Manual retry: wait this long after a trace that did not come back. */
export const RETRY_GAP_MS = 5_000

interface Waiter {
  match: (f: Uint8Array) => boolean
  resolve: (f: Uint8Array) => void
}

/**
 * A companion radio driven from the browser to send TRACE packets. By hand,
 * along a path picked on the map; or automatically: discover the repeaters in
 * direct range, plan round trips that fill the missing measurements around
 * them (companion/planner), and run them one after the other.
 */
export const useTraceStore = defineStore('trace', () => {
  const available = supported()
  const status = ref<'idle' | 'connecting' | 'connected'>('idle')
  const companion = ref<SelfInfo | null>(null)
  const connectError = ref<string | null>(null)
  /** The trace panel is open: clicks on nodes build the path instead of opening them. */
  const open = ref(false)
  /** Manual: the user picks a path. Auto: discover, plan and run traces. */
  const mode = ref<'manual' | 'auto'>('manual')
  const path = ref<string[]>([])
  const running = ref(false)
  const result = ref<TraceResult | null>(null)
  /** Manual mode: send the path again until it comes back. */
  const retryUntilBack = ref(false)
  /** Attempts so far in the current manual run (1 without retry). */
  const attempts = ref(0)
  /** The attempt `result` comes from. */
  const resultAttempt = ref(0)

  // Automatic mode.
  const discovering = ref(false)
  const discovered = ref<DiscoveredRepeater[]>([])
  const discoveredAt = ref<number | null>(null)
  /** Hops from a discovered repeater to the near end of a target link. */
  const depth = ref(2)
  const campaign = ref<CampaignItem[]>([])
  const campaignRunning = ref(false)
  let stopRequested = false
  let wake: (() => void) | null = null

  const transport = shallowRef<Transport | null>(null)
  let waiters: Waiter[] = []
  /** Frame listeners that see every frame, for answers that come in numbers. */
  const listeners = new Set<(f: Uint8Array) => void>()

  const connected = computed(() => status.value === 'connected')
  const selecting = computed(() => open.value && connected.value && mode.value === 'manual')
  const busy = computed(() => running.value || discovering.value || campaignRunning.value)
  const canRun = computed(() => selecting.value && path.value.length > 0 && !busy.value)
  /** The path reads the same both ways: its return already retraces the outbound. */
  const isRoundTrip = computed(() => path.value.join() === [...path.value].reverse().join())

  function onFrame(f: Uint8Array) {
    listeners.forEach((l) => l(f))
    const w = waiters.find((x) => x.match(f))
    if (!w) return
    waiters = waiters.filter((x) => x !== w)
    w.resolve(f)
  }

  function onClose() {
    transport.value = null
    status.value = 'idle'
    companion.value = null
    waiters = []
    listeners.clear()
    stopCampaign()
  }

  /** The next frame matching, or null after timeoutMs (or on disconnection). */
  function waitFor(match: (f: Uint8Array) => boolean, timeoutMs: number): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
      const w: Waiter = {
        match,
        resolve: (f) => {
          window.clearTimeout(timer)
          resolve(f)
        },
      }
      const timer = window.setTimeout(() => {
        waiters = waiters.filter((x) => x !== w)
        resolve(null)
      }, timeoutMs)
      waiters.push(w)
    })
  }

  /** Waits ms, or less if the campaign is stopped meanwhile. */
  function pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = window.setTimeout(done, ms)
      function done() {
        window.clearTimeout(timer)
        wake = null
        resolve()
      }
      wake = done
    })
  }

  async function connect(kind: TransportKind) {
    if (status.value !== 'idle') return
    status.value = 'connecting'
    connectError.value = null
    try {
      const t = await openTransport(kind, { onFrame, onClose })
      transport.value = t
      const reply = waitFor((f) => parseSelfInfo(f) !== null, REPLY_TIMEOUT_MS)
      await t.send(encodeAppStart('MeshQual'))
      const info = await reply
      if (!info) {
        await t.close().catch(() => {})
        throw new Error("pas de réponse : est-ce bien un compagnon MeshCore ?")
      }
      companion.value = parseSelfInfo(info)
      status.value = 'connected'
    } catch (e) {
      onClose()
      // Closing the browser's device picker is not an error worth showing;
      // anything else is, with the browser's own words.
      if (!(e instanceof Cancelled)) connectError.value = e instanceof Error ? e.message : String(e)
    }
  }

  async function disconnect() {
    await transport.value?.close().catch(() => {})
    onClose()
  }

  /**
   * Adds a node to the end of the path, even one already on it: the return
   * leg is the user's to choose. Clicking the last node again takes it back,
   * since a node cannot relay to itself.
   */
  function pickNode(key: string) {
    if (path.value.at(-1) === key) path.value = path.value.slice(0, -1)
    else if (path.value.length < MAX_TRACE_HOPS) path.value = [...path.value, key]
    result.value = null
  }

  function removeAt(i: number) {
    path.value = path.value.filter((_, j) => j !== i)
    result.value = null
  }

  /** Appends the way back along the same nodes: A B C becomes A B C B A. */
  function completeReturn() {
    const rt = roundTrip(path.value)
    if (rt.length <= MAX_TRACE_HOPS) path.value = rt
    result.value = null
  }

  function clearPath() {
    path.value = []
    result.value = null
  }

  /**
   * Sends one trace along `keys` and waits for it to come back. `animate`
   * gets the legs to show on the map: the first half when it leaves, the rest
   * (with every leg's SNR) when it is back.
   */
  async function traceOnce(keys: string[], animate: (hops: TraceHop[]) => void): Promise<TraceResult> {
    const t = transport.value
    const self = companion.value
    if (!t || !self) return { ok: false, reason: 'compagnon déconnecté', at: Date.now() }
    try {
      // Every node the trace visits, from the companion and back to it.
      const visits = [self.publicKey, ...keys, self.publicKey]
      const hops: TraceHop[] = visits.slice(1).map((to, i) => ({ from: visits[i]!, to }))
      const half = Math.ceil(hops.length / 2)

      const tag = crypto.getRandomValues(new Uint32Array(1))[0]!
      const ack = waitFor((f) => f[0] === RESP_ERR || parseSent(f)?.tag === tag, REPLY_TIMEOUT_MS)
      await t.send(encodeTrace(tag, keys))
      const sentFrame = await ack
      if (!sentFrame) return { ok: false, reason: 'le compagnon ne répond pas', at: Date.now() }
      const sent = parseSent(sentFrame)
      if (!sent) return { ok: false, reason: 'trace refusée par le compagnon', at: Date.now() }
      animate(hops.slice(0, half))

      const back = await waitFor((f) => parseTraceData(f)?.tag === tag, sent.timeoutMs + TRACE_MARGIN_MS)
      const data = back && parseTraceData(back)
      if (!data) {
        const s = Math.round((sent.timeoutMs + TRACE_MARGIN_MS) / 1000)
        return {
          ok: false,
          reason: connected.value
            ? `pas de retour après ${s} s : un saut n'a pas relayé`
            : 'compagnon déconnecté pendant la trace',
          at: Date.now(),
        }
      }
      // snrs[i] is what visit i+1 measured hearing visit i; the last leg is
      // the companion hearing the final hop.
      const measured = hops.map((h, i) => ({ ...h, snr: i < data.snrs.length ? data.snrs[i] : data.finalSnr }))
      animate(measured.slice(half))
      return { ok: true, hops: measured, at: Date.now() }
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e), at: Date.now() }
    }
  }

  /**
   * Sends the hand-picked path. With retryUntilBack, sends it again
   * RETRY_GAP_MS after each trace that does not come back, until one does or
   * the user stops it.
   */
  async function run(animate: (hops: TraceHop[]) => void) {
    if (!canRun.value) return
    running.value = true
    result.value = null
    attempts.value = 0
    stopRequested = false
    const keys = [...path.value]
    try {
      for (;;) {
        attempts.value++
        const r = await traceOnce(keys, animate)
        result.value = r
        resultAttempt.value = attempts.value
        if (result.value.ok || !retryUntilBack.value || stopRequested || !connected.value) break
        await pause(RETRY_GAP_MS)
        if (stopRequested || !connected.value) break
      }
    } finally {
      running.value = false
    }
  }

  /**
   * Asks the repeaters in direct range to answer, and collects the answers
   * for DISCOVER_WINDOW_MS. Each gives the link to the companion both ways.
   */
  async function discover() {
    const t = transport.value
    if (!t || busy.value) return
    discovering.value = true
    discovered.value = []
    campaign.value = []
    const tag = crypto.getRandomValues(new Uint32Array(1))[0]!
    const found = new Map<string, DiscoveredRepeater>()
    const listen = (f: Uint8Array) => {
      const r = parseDiscoverResponse(f)
      if (!r || r.tag !== tag || r.publicKey === companion.value?.publicKey) return
      found.set(r.publicKey, r)
      discovered.value = [...found.values()].sort((a, b) => b.snrAtCompanion - a.snrAtCompanion)
    }
    listeners.add(listen)
    try {
      const ack = waitFor((f) => f[0] === RESP_OK || f[0] === RESP_ERR, REPLY_TIMEOUT_MS)
      await t.send(encodeDiscover(tag))
      const reply = await ack
      if (reply?.[0] === RESP_OK) await pause(DISCOVER_WINDOW_MS)
    } finally {
      listeners.delete(listen)
      discovering.value = false
      discoveredAt.value = Date.now()
    }
  }

  /**
   * Listen-only observers (the server's call: never seen relaying). Their
   * links are not served, so no plan reaches them; this keeps them from
   * being picked as a starting repeater too.
   */
  const observers = computed(
    () => new Set(useMeshStore().nodes.features.filter((f) => f.properties.listenOnly).map((f) => f.properties.key)),
  )

  /** The traces the automatic mode would run, from what the map knows now. */
  const proposal = computed<PlannedTrace[]>(() => {
    if (!discovered.value.length) return []
    const mesh = useMeshStore()
    return planTraces(
      discovered.value.map((r) => r.publicKey),
      mesh.links.features.map((f) => f.properties),
      { self: companion.value?.publicKey, maxDepth: depth.value, avoid: observers.value },
    )
  })

  /** Runs the proposed traces one after the other, with a pause between them. */
  async function runCampaign(animate: (hops: TraceHop[]) => void) {
    if (busy.value || !proposal.value.length) return
    campaign.value = proposal.value.map((p) => ({ ...p, status: 'pending' }))
    campaignRunning.value = true
    stopRequested = false
    try {
      for (let i = 0; i < campaign.value.length; i++) {
        if (stopRequested || !connected.value) break
        if (i > 0) await pause(CAMPAIGN_GAP_MS)
        if (stopRequested || !connected.value) break
        campaign.value[i]!.status = 'running'
        const r = await traceOnce(campaign.value[i]!.path, animate)
        campaign.value[i]!.result = r
        campaign.value[i]!.status = r.ok ? 'ok' : 'ko'
      }
    } finally {
      campaignRunning.value = false
    }
  }

  /** Stops after the trace in flight (campaign or manual retry); also cuts a wait short. */
  function stopCampaign() {
    stopRequested = true
    wake?.()
  }

  /**
   * Every link reading to label on the map: the discovery's (both ways
   * between the companion and each repeater) and those of returned traces.
   * The latest reading of each direction wins.
   */
  const labelHops = computed<TraceHop[]>(() => {
    const self = companion.value?.publicKey
    const byDir = new Map<string, TraceHop>()
    const put = (h: TraceHop) => h.snr !== undefined && byDir.set(`${h.from}>${h.to}`, h)
    if (self && mode.value === 'auto') {
      for (const r of discovered.value) {
        put({ from: self, to: r.publicKey, snr: r.snrAtRepeater })
        put({ from: r.publicKey, to: self, snr: r.snrAtCompanion })
      }
      for (const c of campaign.value) if (c.result?.ok) c.result.hops.forEach(put)
    } else if (result.value?.ok) {
      result.value.hops.forEach(put)
    }
    return [...byDir.values()]
  })

  /**
   * The routes the map keeps in focus, fading the rest: the hand-picked path
   * once sent, or in automatic mode the discovered repeaters and the planned
   * (or running) traces. Each route starts and ends at the companion.
   */
  const focusPaths = computed<string[][] | null>(() => {
    const self = companion.value?.publicKey
    if (!open.value || !self) return null
    if (mode.value === 'manual') {
      if (!(running.value || result.value) || !path.value.length) return null
      return [[self, ...path.value, self]]
    }
    const routes = [
      ...discovered.value.map((r) => [self, r.publicKey, self]),
      ...(campaign.value.length ? campaign.value : proposal.value).map((p) => [self, ...p.path, self]),
    ]
    return routes.length ? routes : null
  })

  /** The trace being sent in automatic mode, drawn like a hand-picked path. */
  const currentCampaignPath = computed(() => campaign.value.find((c) => c.status === 'running')?.path ?? [])

  return {
    available,
    status,
    companion,
    connectError,
    open,
    mode,
    path,
    running,
    result,
    retryUntilBack,
    attempts,
    resultAttempt,
    selecting,
    busy,
    canRun,
    connect,
    disconnect,
    isRoundTrip,
    pickNode,
    removeAt,
    completeReturn,
    clearPath,
    run,
    discovering,
    discovered,
    discoveredAt,
    depth,
    proposal,
    observers,
    campaign,
    campaignRunning,
    discover,
    runCampaign,
    stopCampaign,
    labelHops,
    focusPaths,
    currentCampaignPath,
  }
})
