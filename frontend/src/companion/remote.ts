/**
 * Companion protocol frames for managing one's own repeaters and room servers
 * from the browser, as the MeshCore app does (examples/companion_radio
 * MyMesh.cpp): the node must be a contact of the companion, a login opens a
 * session with the node's password, then status requests and CLI commands
 * travel over the mesh. Pure encoding and decoding, like protocol.ts.
 */

export const CMD_SEND_TXT_MSG = 2
export const CMD_ADD_UPDATE_CONTACT = 9
export const CMD_SYNC_NEXT_MESSAGE = 10
export const CMD_SEND_LOGIN = 26
export const CMD_SEND_STATUS_REQ = 27
export const CMD_LOGOUT = 29
export const CMD_GET_CONTACT_BY_KEY = 30

export const RESP_CONTACT = 3
export const RESP_CONTACT_MSG_RECV = 7
export const RESP_NO_MORE_MESSAGES = 10
export const RESP_CONTACT_MSG_RECV_V3 = 16
export const PUSH_MSG_WAITING = 0x83
export const PUSH_LOGIN_SUCCESS = 0x85
export const PUSH_LOGIN_FAIL = 0x86
export const PUSH_STATUS_RESPONSE = 0x87

const TXT_TYPE_CLI_DATA = 1
const OUT_PATH_UNKNOWN = 0xff
const MAX_PATH_SIZE = 64
const ADV_TYPE: Record<string, number> = { companion: 1, repeater: 2, room: 3, sensor: 4 }

const enc = new TextEncoder()
const dec = new TextDecoder()

function keyBytes(key: string): Uint8Array {
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) out[i] = parseInt(key.slice(i * 2, i * 2 + 2), 16)
  return out
}

const prefixHex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()

/** Is this 6-byte key prefix (upper-case hex, 12 chars) the start of key? */
export const samePrefix = (prefix: string, key: string) => key.toUpperCase().startsWith(prefix)

export function encodeGetContact(key: string): Uint8Array {
  const out = new Uint8Array(33)
  out[0] = CMD_GET_CONTACT_BY_KEY
  out.set(keyBytes(key), 1)
  return out
}

/**
 * Adds the node to the companion's contacts with no known path: the first
 * request goes out flood and the reply teaches the companion a direct path.
 */
export function encodeAddContact(key: string, nodeType: string, name: string): Uint8Array {
  const out = new Uint8Array(1 + 32 + 3 + MAX_PATH_SIZE + 32 + 4 + 8)
  let i = 0
  out[i++] = CMD_ADD_UPDATE_CONTACT
  out.set(keyBytes(key), i)
  i += 32
  out[i++] = ADV_TYPE[nodeType] ?? ADV_TYPE.repeater!
  out[i++] = 0 // flags
  out[i++] = OUT_PATH_UNKNOWN
  i += MAX_PATH_SIZE
  out.set(enc.encode(name).subarray(0, 31), i)
  return out // last advert time, lat, lon: zero
}

export function encodeLogin(key: string, password: string): Uint8Array {
  const pwd = enc.encode(password).subarray(0, 15)
  const out = new Uint8Array(33 + pwd.length)
  out[0] = CMD_SEND_LOGIN
  out.set(keyBytes(key), 1)
  out.set(pwd, 33)
  return out
}

export function encodeStatusRequest(key: string): Uint8Array {
  const out = new Uint8Array(33)
  out[0] = CMD_SEND_STATUS_REQ
  out.set(keyBytes(key), 1)
  return out
}

export function encodeLogout(key: string): Uint8Array {
  const out = new Uint8Array(33)
  out[0] = CMD_LOGOUT
  out.set(keyBytes(key), 1)
  return out
}

/** A CLI command for a node the companion is logged in to as admin. */
export function encodeCli(key: string, command: string): Uint8Array {
  const text = enc.encode(command)
  const out = new Uint8Array(13 + text.length)
  out[0] = CMD_SEND_TXT_MSG
  out[1] = TXT_TYPE_CLI_DATA
  out[2] = 0 // attempt
  // bytes 3-6: timestamp, replaced by the companion's clock for CLI data
  out.set(keyBytes(key).subarray(0, 6), 7)
  out.set(text, 13)
  return out
}

export const encodeSyncNext = () => new Uint8Array([CMD_SYNC_NEXT_MESSAGE])

export interface RequestSent {
  /** The request went out flood (no known path yet) rather than direct. */
  flood: boolean
  /** The companion's estimate of the round trip, in ms. */
  timeoutMs: number
}

/** The SENT reply to a login, status request or message. */
export function parseRequestSent(f: Uint8Array): RequestSent | null {
  if (f[0] !== 0x06 || f.length < 10) return null
  return { flood: f[1] === 1, timeoutMs: new DataView(f.buffer, f.byteOffset).getUint32(6, true) }
}

export interface LoginResult {
  ok: boolean
  prefix: string
  admin: boolean
}

export function parseLoginResult(f: Uint8Array): LoginResult | null {
  if ((f[0] !== PUSH_LOGIN_SUCCESS && f[0] !== PUSH_LOGIN_FAIL) || f.length < 8) return null
  const ok = f[0] === PUSH_LOGIN_SUCCESS
  // byte 1: is_admin; byte 12 (newer firmware): ACL role, 3 = admin.
  const admin = ok && (f[1] === 1 || (f.length > 12 && (f[12]! & 3) === 3))
  return { ok, prefix: prefixHex(f.subarray(2, 8)), admin }
}

/** A repeater's or room server's RepeaterStats (simple_repeater MyMesh.h). */
export interface NodeStats {
  prefix: string
  battMv: number
  txQueue: number
  noiseFloor: number
  lastRssi: number
  lastSnr?: number
  recv: number
  sent: number
  airTimeSec: number
  upTimeSec: number
  sentFlood: number
  sentDirect: number
  recvFlood: number
  recvDirect: number
  errEvents?: number
  dupsDirect?: number
  dupsFlood?: number
  rxAirTimeSec?: number
  recvErrors?: number
}

export function parseStatus(f: Uint8Array): NodeStats | null {
  if (f[0] !== PUSH_STATUS_RESPONSE || f.length < 8 + 40) return null
  const v = new DataView(f.buffer, f.byteOffset, f.byteLength)
  const o = 8
  const has = (end: number) => f.length >= o + end
  return {
    prefix: prefixHex(f.subarray(2, 8)),
    battMv: v.getUint16(o, true),
    txQueue: v.getUint16(o + 2, true),
    noiseFloor: v.getInt16(o + 4, true),
    lastRssi: v.getInt16(o + 6, true),
    recv: v.getUint32(o + 8, true),
    sent: v.getUint32(o + 12, true),
    airTimeSec: v.getUint32(o + 16, true),
    upTimeSec: v.getUint32(o + 20, true),
    sentFlood: v.getUint32(o + 24, true),
    sentDirect: v.getUint32(o + 28, true),
    recvFlood: v.getUint32(o + 32, true),
    recvDirect: v.getUint32(o + 36, true),
    ...(has(42) && { errEvents: v.getUint16(o + 40, true) }),
    ...(has(44) && { lastSnr: v.getInt16(o + 42, true) / 4 }),
    ...(has(48) && { dupsDirect: v.getUint16(o + 44, true), dupsFlood: v.getUint16(o + 46, true) }),
    ...(has(52) && { rxAirTimeSec: v.getUint32(o + 48, true) }),
    ...(has(56) && { recvErrors: v.getUint32(o + 52, true) }),
  }
}

export interface CliReply {
  prefix: string
  text: string
}

/** A CLI reply from a node, as CMD_SYNC_NEXT_MESSAGE hands it over. */
export function parseCliReply(f: Uint8Array): CliReply | null {
  // v3 frames carry SNR and two reserved bytes before the common part.
  const o = f[0] === RESP_CONTACT_MSG_RECV_V3 ? 4 : f[0] === RESP_CONTACT_MSG_RECV ? 1 : -1
  if (o < 0 || f.length < o + 12 || f[o + 7] !== TXT_TYPE_CLI_DATA) return null
  return { prefix: prefixHex(f.subarray(o, o + 6)), text: dec.decode(f.subarray(o + 12)).replace(/\0+$/, '') }
}

/** "> value" (a get) gives value; anything else is the reply as is. */
export const cliValue = (reply: string) => reply.replace(/^>\s?/, '').trim()
