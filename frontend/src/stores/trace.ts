import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import {
  encodeAppStart,
  encodeTrace,
  parseSelfInfo,
  parseSent,
  parseTraceData,
  RESP_ERR,
  roundTrip,
  type SelfInfo,
} from '@/companion/protocol'
import {
  Cancelled,
  connect as openTransport,
  supported,
  type Transport,
  type TransportKind,
} from '@/companion/transport'

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

const REPLY_TIMEOUT_MS = 5_000
/** Slack on top of the firmware's own round-trip estimate. */
const TRACE_MARGIN_MS = 4_000

interface Waiter {
  match: (f: Uint8Array) => boolean
  resolve: (f: Uint8Array) => void
}

/**
 * A companion radio driven from the browser to send TRACE packets along a path
 * picked on the map. The trace goes out and back the same way, so it returns
 * the SNR of both directions of every link on the path.
 */
export const useTraceStore = defineStore('trace', () => {
  const available = supported()
  const status = ref<'idle' | 'connecting' | 'connected'>('idle')
  const companion = ref<SelfInfo | null>(null)
  const connectError = ref<string | null>(null)
  /** The trace panel is open: clicks on nodes build the path instead of opening them. */
  const open = ref(false)
  const path = ref<string[]>([])
  const running = ref(false)
  const result = ref<TraceResult | null>(null)

  const transport = shallowRef<Transport | null>(null)
  let waiters: Waiter[] = []

  const selecting = computed(() => open.value && status.value === 'connected')
  const canRun = computed(() => selecting.value && path.value.length > 0 && !running.value)

  function onFrame(f: Uint8Array) {
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

  /** Adds a node to the end of the path, or takes it out if already there. */
  function toggleNode(key: string) {
    path.value = path.value.includes(key) ? path.value.filter((k) => k !== key) : [...path.value, key]
    result.value = null
  }

  function clearPath() {
    path.value = []
    result.value = null
  }

  /**
   * Sends the trace and waits for it to come back. `animate` gets the legs to
   * show on the map: the outbound ones when it leaves, the return ones (with
   * their SNR) when it is back.
   */
  async function run(animate: (hops: TraceHop[]) => void) {
    const t = transport.value
    const self = companion.value
    if (!t || !self || !canRun.value) return
    running.value = true
    result.value = null
    const done = (r: TraceResult) => {
      result.value = r
      running.value = false
    }
    try {
      const keys = roundTrip(path.value)
      // Every node the trace visits, from the companion and back to it.
      const visits = [self.publicKey, ...keys, self.publicKey]
      const hops: TraceHop[] = visits.slice(1).map((to, i) => ({ from: visits[i]!, to }))
      const outbound = hops.slice(0, path.value.length)

      const tag = crypto.getRandomValues(new Uint32Array(1))[0]!
      const ack = waitFor((f) => f[0] === RESP_ERR || parseSent(f)?.tag === tag, REPLY_TIMEOUT_MS)
      await t.send(encodeTrace(tag, keys))
      const sentFrame = await ack
      if (!sentFrame) return done({ ok: false, reason: 'le compagnon ne répond pas', at: Date.now() })
      const sent = parseSent(sentFrame)
      if (!sent) return done({ ok: false, reason: 'trace refusée par le compagnon', at: Date.now() })
      animate(outbound)

      const back = await waitFor((f) => parseTraceData(f)?.tag === tag, sent.timeoutMs + TRACE_MARGIN_MS)
      const data = back && parseTraceData(back)
      if (!data) {
        const s = Math.round((sent.timeoutMs + TRACE_MARGIN_MS) / 1000)
        return done({
          ok: false,
          reason:
            status.value === 'connected'
              ? `pas de retour après ${s} s : un saut n'a pas relayé`
              : 'compagnon déconnecté pendant la trace',
          at: Date.now(),
        })
      }
      // snrs[i] is what visit i+1 measured hearing visit i; the last leg is
      // the companion hearing the final hop.
      const measured = hops.map((h, i) => ({ ...h, snr: i < data.snrs.length ? data.snrs[i] : data.finalSnr }))
      animate(measured.slice(path.value.length))
      done({ ok: true, hops: measured, at: Date.now() })
    } catch (e) {
      done({ ok: false, reason: e instanceof Error ? e.message : String(e), at: Date.now() })
    }
  }

  return {
    available,
    status,
    companion,
    connectError,
    open,
    path,
    running,
    result,
    selecting,
    canRun,
    connect,
    disconnect,
    toggleNode,
    clearPath,
    run,
  }
})
