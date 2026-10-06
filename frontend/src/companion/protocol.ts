/**
 * The few MeshCore companion protocol frames a trace needs (see the firmware's
 * docs/companion_protocol.md and examples/companion_radio/MyMesh.cpp). Pure
 * encoding and decoding, no transport: BLE carries one frame per
 * notification, USB serial wraps each frame in a 3-byte header (SerialFramer).
 */

export const CMD_APP_START = 0x01
export const CMD_SEND_TRACE_PATH = 36
export const RESP_ERR = 0x01
export const RESP_SELF_INFO = 0x05
export const RESP_SENT = 0x06
export const PUSH_TRACE_DATA = 0x89

/** Path hash width used for traces. 2 bytes keeps collisions rare; firmware v1.11+. */
export const TRACE_HASH_BYTES = 2

export interface SelfInfo {
  publicKey: string // upper-case hex, like the API's node keys
  name: string
}

export interface TraceSent {
  tag: number
  /** The firmware's estimate of the round trip, in ms. */
  timeoutMs: number
}

export interface TraceData {
  tag: number
  /** Hop hashes in path order, upper-case hex. */
  hashes: string[]
  /** SNR (dB) each hop measured receiving the trace, in path order. */
  snrs: number[]
  /** SNR (dB) at the companion, hearing the last hop. */
  finalSnr: number
}

const enc = new TextEncoder()
const dec = new TextDecoder()

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase()

export function encodeAppStart(appName: string): Uint8Array {
  const name = enc.encode(appName)
  const out = new Uint8Array(8 + name.length)
  out[0] = CMD_APP_START
  out.set(name, 8)
  return out
}

/** The first `bytes` bytes of a node's public key: its hash in a path. */
export function pathHash(key: string, bytes = TRACE_HASH_BYTES): Uint8Array {
  const out = new Uint8Array(bytes)
  for (let i = 0; i < bytes; i++) out[i] = parseInt(key.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * The trace path for the nodes picked in order: out and back the same way,
 * since the trace must come home for the companion to hear it, and the return
 * leg measures the other direction of every link. [A, B, C] → A B C B A.
 */
export function roundTrip<T>(nodes: T[]): T[] {
  return [...nodes, ...nodes.slice(0, -1).reverse()]
}

export function encodeTrace(tag: number, keys: string[], hashBytes = TRACE_HASH_BYTES): Uint8Array {
  const out = new Uint8Array(10 + keys.length * hashBytes)
  const view = new DataView(out.buffer)
  out[0] = CMD_SEND_TRACE_PATH
  view.setUint32(1, tag >>> 0, true)
  view.setUint32(5, 0, true) // auth code: unused for a plain path trace
  out[9] = Math.log2(hashBytes) & 0x03 // flags: path hash size as a power of two
  keys.forEach((k, i) => out.set(pathHash(k, hashBytes), 10 + i * hashBytes))
  return out
}

export function parseSelfInfo(f: Uint8Array): SelfInfo | null {
  if (f[0] !== RESP_SELF_INFO || f.length < 58) return null
  return { publicKey: hex(f.subarray(4, 36)), name: dec.decode(f.subarray(58)).replace(/\0.*$/, '') }
}

export function parseSent(f: Uint8Array): TraceSent | null {
  if (f[0] !== RESP_SENT || f.length < 10) return null
  const view = new DataView(f.buffer, f.byteOffset, f.byteLength)
  return { tag: view.getUint32(2, true), timeoutMs: view.getUint32(6, true) }
}

export function parseTraceData(f: Uint8Array): TraceData | null {
  if (f[0] !== PUSH_TRACE_DATA || f.length < 12) return null
  const view = new DataView(f.buffer, f.byteOffset, f.byteLength)
  const pathLen = f[2]!
  const size = 1 << (f[3]! & 0x03)
  const hops = pathLen / size
  if (!Number.isInteger(hops) || f.length < 12 + pathLen + hops + 1) return null
  const hashes: string[] = []
  for (let i = 0; i < hops; i++) hashes.push(hex(f.subarray(12 + i * size, 12 + (i + 1) * size)))
  const snrAt = (i: number) => view.getInt8(i) / 4
  const snrs = Array.from({ length: hops }, (_, i) => snrAt(12 + pathLen + i))
  return { tag: view.getUint32(4, true), hashes, snrs, finalSnr: snrAt(12 + pathLen + hops) }
}

/**
 * USB serial framing: frames from the app go out as '<' len_lo len_hi data,
 * frames from the radio come back as '>' len_lo len_hi data, possibly split
 * or merged across reads.
 */
export function serialFrame(frame: Uint8Array): Uint8Array {
  const out = new Uint8Array(3 + frame.length)
  out[0] = 0x3c // '<'
  out[1] = frame.length & 0xff
  out[2] = frame.length >> 8
  out.set(frame, 3)
  return out
}

export class SerialFramer {
  private buf = new Uint8Array(0)

  /** Feeds raw bytes, returns the complete frames they finish. */
  push(chunk: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.buf.length + chunk.length)
    merged.set(this.buf)
    merged.set(chunk, this.buf.length)
    const frames: Uint8Array[] = []
    let i = 0
    for (;;) {
      while (i < merged.length && merged[i] !== 0x3e) i++ // resync on '>'
      if (merged.length - i < 3) break
      const len = merged[i + 1]! | (merged[i + 2]! << 8)
      if (merged.length - i - 3 < len) break
      frames.push(merged.slice(i + 3, i + 3 + len))
      i += 3 + len
    }
    this.buf = merged.slice(i)
    return frames
  }
}
