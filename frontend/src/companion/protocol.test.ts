import { describe, expect, it } from 'vitest'
import {
  encodeAppStart,
  encodeTrace,
  parseSelfInfo,
  parseSent,
  parseTraceData,
  roundTrip,
  SerialFramer,
  serialFrame,
} from './protocol'

const KEY_A = 'AB12' + '00'.repeat(30)
const KEY_B = 'CD34' + '11'.repeat(30)

describe('roundTrip', () => {
  it('goes out and back the same way', () => {
    expect(roundTrip(['A', 'B', 'C'])).toEqual(['A', 'B', 'C', 'B', 'A'])
    expect(roundTrip(['A'])).toEqual(['A'])
    expect(roundTrip([])).toEqual([])
  })
})

describe('encodeTrace', () => {
  it('lays out tag, auth, flags and 2-byte hashes as the firmware reads them', () => {
    const f = encodeTrace(0x01020304, [KEY_A, KEY_B, KEY_A])
    expect(Array.from(f)).toEqual([
      36, 0x04, 0x03, 0x02, 0x01, 0, 0, 0, 0, 1, 0xab, 0x12, 0xcd, 0x34, 0xab, 0x12,
    ])
  })
})

describe('encodeAppStart', () => {
  it('puts the app name after seven reserved bytes', () => {
    const f = encodeAppStart('mq')
    expect(Array.from(f)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0x6d, 0x71])
  })
})

describe('responses', () => {
  it('reads SELF_INFO', () => {
    const f = new Uint8Array(62)
    f[0] = 5
    f.set([0xab, 0x12], 4)
    f.set(new TextEncoder().encode('Kiwi'), 58)
    const s = parseSelfInfo(f)!
    expect(s.name).toBe('Kiwi')
    expect(s.publicKey.startsWith('AB12')).toBe(true)
    expect(s.publicKey).toHaveLength(64)
  })

  it('reads SENT', () => {
    expect(parseSent(new Uint8Array([6, 0, 4, 3, 2, 1, 0x10, 0x27, 0, 0]))).toEqual({
      tag: 0x01020304,
      timeoutMs: 10_000,
    })
  })

  it('reads TRACE_DATA with per-hop SNR in quarter dB', () => {
    // 3 hops of 2-byte hashes: path_len 6, flags 1.
    const f = new Uint8Array([
      0x89, 0, 6, 1, 4, 3, 2, 1, 0, 0, 0, 0,
      0xab, 0x12, 0xcd, 0x34, 0xab, 0x12,
      20, 0xf8, 9, // 5, -2, 2.25 dB
      0xfc, // final -1 dB
    ])
    expect(parseTraceData(f)).toEqual({
      tag: 0x01020304,
      hashes: ['AB12', 'CD34', 'AB12'],
      snrs: [5, -2, 2.25],
      finalSnr: -1,
    })
  })

  it('rejects truncated frames', () => {
    expect(parseTraceData(new Uint8Array([0x89, 0, 6, 1, 4, 3, 2, 1, 0, 0, 0, 0, 0xab]))).toBeNull()
    expect(parseSent(new Uint8Array([6, 0]))).toBeNull()
  })
})

describe('serial framing', () => {
  it('wraps outgoing frames', () => {
    expect(Array.from(serialFrame(new Uint8Array([1, 2])))).toEqual([0x3c, 2, 0, 1, 2])
  })

  it('reassembles split and merged incoming frames, skipping noise', () => {
    const fr = new SerialFramer()
    expect(fr.push(new Uint8Array([0x00, 0x3e, 3, 0, 9]))).toEqual([])
    const out = fr.push(new Uint8Array([8, 7, 0x3e, 1, 0, 5]))
    expect(out.map((f) => Array.from(f))).toEqual([[9, 8, 7], [5]])
  })
})
