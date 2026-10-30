import { RESP_ERR, RESP_OK } from './protocol'
import {
  cliValue,
  contactHasPath,
  encodeAddContact,
  encodeCli,
  encodeContactRoute,
  encodeGetContact,
  encodeResetPath,
  encodeStatusRequest,
  encodeSyncNext,
  parseCliReply,
  parseRequestSent,
  parseStatus,
  PUSH_MSG_WAITING,
  RESP_CONTACT,
  RESP_NO_MORE_MESSAGES,
  samePrefix,
  type NodeStats,
} from './remote'

/** What the node panel needs from the connected companion (stores/trace). */
export interface CompanionLink {
  exchange(frame: Uint8Array, match: (f: Uint8Array) => boolean, timeoutMs?: number): Promise<Uint8Array | null>
  listen(l: (f: Uint8Array) => void): () => void
  waitFor(match: (f: Uint8Array) => boolean, timeoutMs: number): Promise<Uint8Array | null>
}

const MARGIN_MS = 8_000
const isSentOrErr = (f: Uint8Array) => f[0] === 0x06 || f[0] === RESP_ERR
/** Frames CMD_SYNC_NEXT_MESSAGE answers with. */
const SYNC_REPLIES = new Set([7, 8, RESP_NO_MORE_MESSAGES, 16, 17, 27])

/** The node did not answer a request; `direct` when it went along a stored path. */
export class NoReply extends Error {
  constructor(
    message: string,
    readonly direct: boolean,
  ) {
    super(message)
  }
}

const isOkOrErr = (f: Uint8Array) => f[0] === RESP_OK || f[0] === RESP_ERR

/**
 * Makes sure the node is a contact of the companion, which requests need.
 * `route` (the repeaters a returned trace went through to reach it) becomes
 * the contact's path when the companion knows none, so requests go direct
 * instead of flooding the mesh; a path the companion learned itself is kept.
 * Returns true when the route was written.
 */
export async function ensureContact(
  c: CompanionLink,
  key: string,
  nodeType: string,
  name: string,
  route?: string[] | null,
): Promise<boolean> {
  const got = await c.exchange(encodeGetContact(key), (f) => f[0] === RESP_CONTACT || f[0] === RESP_ERR)
  if (got?.[0] === RESP_CONTACT) {
    if (!route || contactHasPath(got)) return false
    const updated = await c.exchange(encodeContactRoute(got, route), isOkOrErr)
    return updated?.[0] === RESP_OK
  }
  const added = await c.exchange(encodeAddContact(key, nodeType, name, route), isOkOrErr)
  if (added?.[0] !== RESP_OK) throw new Error("le compagnon n'a pas pu ajouter ce nœud à ses contacts")
  return !!route
}

/** Forgets the contact's stored path: the next request goes out flood. */
export async function resetPath(c: CompanionLink, key: string) {
  const r = await c.exchange(encodeResetPath(key), isOkOrErr)
  if (r?.[0] !== RESP_OK) throw new Error("le compagnon n'a pas pu oublier le chemin")
}

/**
 * Runs `request`, and once more out flood if it went along a stored path and
 * got no answer: a repeater on that path may be gone. `onReset` is told when
 * the path is dropped.
 */
export async function withFloodRetry<T>(
  c: CompanionLink,
  key: string,
  request: () => Promise<T>,
  onReset?: () => void,
): Promise<T> {
  try {
    return await request()
  } catch (e) {
    if (!(e instanceof NoReply) || !e.direct) throw e
    await resetPath(c, key)
    onReset?.()
    return request()
  }
}

/** Asks the node for its statistics. */
export async function requestStatus(c: CompanionLink, key: string): Promise<NodeStats> {
  const sentFrame = await c.exchange(encodeStatusRequest(key), isSentOrErr)
  const sent = sentFrame && parseRequestSent(sentFrame)
  if (!sent) throw new Error('demande refusée par le compagnon')
  const f = await c.waitFor((x) => {
    const s = parseStatus(x)
    return !!s && samePrefix(s.prefix, key)
  }, sent.timeoutMs + MARGIN_MS)
  if (!f) throw new NoReply('pas de réponse du nœud', !sent.flood)
  return parseStatus(f)!
}

/**
 * Runs one CLI command on the node and returns its reply. Replies come back
 * as messages: the companion signals one is waiting, and they are pulled one
 * by one until the reply for this node shows up.
 */
export async function runCli(c: CompanionLink, key: string, command: string): Promise<string> {
  let resolve!: (text: string | null) => void
  const reply = new Promise<string | null>((r) => (resolve = r))
  let draining = false
  const drain = async () => {
    if (draining) return
    draining = true
    try {
      for (;;) {
        const f = await c.exchange(encodeSyncNext(), (x) => SYNC_REPLIES.has(x[0]!))
        if (!f || f[0] === RESP_NO_MORE_MESSAGES) break
        const r = parseCliReply(f)
        if (r && samePrefix(r.prefix, key)) {
          resolve(r.text)
          break
        }
      }
    } finally {
      draining = false
    }
  }
  const stop = c.listen((f) => {
    if (f[0] === PUSH_MSG_WAITING) void drain()
  })
  try {
    const sentFrame = await c.exchange(encodeCli(key, command), isSentOrErr)
    const sent = sentFrame && parseRequestSent(sentFrame)
    if (!sent) throw new Error('commande refusée par le compagnon')
    const timer = setTimeout(() => resolve(null), sent.timeoutMs + MARGIN_MS)
    void drain() // a reply may already be waiting
    const text = await reply
    clearTimeout(timer)
    if (text === null) throw new NoReply('pas de réponse du nœud', !sent.flood)
    return text
  } finally {
    stop()
  }
}

export const getParam = async (c: CompanionLink, key: string, name: string) =>
  cliValue(await runCli(c, key, `get ${name}`))
