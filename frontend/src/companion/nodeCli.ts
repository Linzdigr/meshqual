import { RESP_ERR, RESP_OK } from './protocol'
import {
  cliValue,
  encodeAddContact,
  encodeCli,
  encodeGetContact,
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

/** Makes sure the node is a contact of the companion, which requests need. */
export async function ensureContact(c: CompanionLink, key: string, nodeType: string, name: string) {
  const got = await c.exchange(encodeGetContact(key), (f) => f[0] === RESP_CONTACT || f[0] === RESP_ERR)
  if (got?.[0] === RESP_CONTACT) return
  const added = await c.exchange(encodeAddContact(key, nodeType, name), (f) => f[0] === RESP_OK || f[0] === RESP_ERR)
  if (added?.[0] !== RESP_OK) throw new Error("le compagnon n'a pas pu ajouter ce nœud à ses contacts")
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
  if (!f) throw new Error('pas de réponse du nœud')
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
    if (text === null) throw new Error('pas de réponse du nœud')
    return text
  } finally {
    stop()
  }
}

export const getParam = async (c: CompanionLink, key: string, name: string) =>
  cliValue(await runCli(c, key, `get ${name}`))
