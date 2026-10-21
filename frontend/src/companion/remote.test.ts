import { describe, expect, it } from 'vitest'
import {
  cliValue,
  encodeAddContact,
  encodeCli,
  encodeLogin,
  parseCliReply,
  parseLoginResult,
  parseRequestSent,
  parseStatus,
} from './remote'

const KEY = 'AB12CD34EF56' + '00'.repeat(26)

describe('requests', () => {
  it('logs in with the key and the password', () => {
    const f = encodeLogin(KEY, 'pw')
    expect(f[0]).toBe(26)
    expect(Array.from(f.subarray(1, 4))).toEqual([0xab, 0x12, 0xcd])
    expect(new TextDecoder().decode(f.subarray(33))).toBe('pw')
  })

  it('adds a contact with no known path', () => {
    const f = encodeAddContact(KEY, 'room', 'Salon')
    expect(f[0]).toBe(9)
    expect(f[33]).toBe(3) // room
    expect(f[35]).toBe(0xff) // path unknown
    expect(new TextDecoder().decode(f.subarray(100, 105))).toBe('Salon')
    expect(f.length).toBe(1 + 32 + 3 + 64 + 32 + 4 + 8)
  })

  it('sends CLI text to the 6-byte key prefix', () => {
    const f = encodeCli(KEY, 'get name')
    expect(Array.from(f.subarray(0, 3))).toEqual([2, 1, 0])
    expect(Array.from(f.subarray(7, 13))).toEqual([0xab, 0x12, 0xcd, 0x34, 0xef, 0x56])
    expect(new TextDecoder().decode(f.subarray(13))).toBe('get name')
  })
})

describe('replies', () => {
  it('reads SENT: flood or direct, and the estimate', () => {
    expect(parseRequestSent(new Uint8Array([6, 1, 0, 0, 0, 0, 0x88, 0x13, 0, 0]))).toEqual({ flood: true, timeoutMs: 5000 })
  })

  it('reads a login, admin or not', () => {
    const ok = new Uint8Array([0x85, 1, 0xab, 0x12, 0xcd, 0x34, 0xef, 0x56, 0, 0, 0, 0, 3, 1])
    expect(parseLoginResult(ok)).toEqual({ ok: true, prefix: 'AB12CD34EF56', admin: true })
    const guest = new Uint8Array([0x85, 0, 0xab, 0x12, 0xcd, 0x34, 0xef, 0x56, 0, 0, 0, 0, 0, 1])
    expect(parseLoginResult(guest)?.admin).toBe(false)
    const fail = new Uint8Array([0x86, 0, 0xab, 0x12, 0xcd, 0x34, 0xef, 0x56])
    expect(parseLoginResult(fail)).toEqual({ ok: false, prefix: 'AB12CD34EF56', admin: false })
  })

  it('reads the full RepeaterStats', () => {
    const f = new Uint8Array(8 + 56)
    const v = new DataView(f.buffer)
    f[0] = 0x87
    f.set([0xab, 0x12, 0xcd, 0x34, 0xef, 0x56], 2)
    v.setUint16(8, 4012, true) // battery mV
    v.setUint16(10, 2, true) // tx queue
    v.setInt16(12, -112, true) // noise floor
    v.setInt16(14, -95, true) // last RSSI
    v.setUint32(28, 86_400, true) // uptime
    v.setInt16(50, -26, true) // last SNR x4
    v.setUint32(60, 7, true) // recv errors
    const s = parseStatus(f)!
    expect(s).toMatchObject({ battMv: 4012, txQueue: 2, noiseFloor: -112, lastRssi: -95, upTimeSec: 86_400 })
    expect(s.lastSnr).toBe(-6.5)
    expect(s.recvErrors).toBe(7)
  })

  it('reads older, shorter stats without the newer fields', () => {
    const f = new Uint8Array(8 + 40)
    f[0] = 0x87
    const s = parseStatus(f)!
    expect(s.lastSnr).toBeUndefined()
    expect(s.recvErrors).toBeUndefined()
  })

  it('reads a CLI reply in both message formats, and ignores chat', () => {
    const body = [0xab, 0x12, 0xcd, 0x34, 0xef, 0x56, 0xff, 1, 0, 0, 0, 0, ...new TextEncoder().encode('> on')]
    expect(parseCliReply(new Uint8Array([7, ...body]))).toEqual({ prefix: 'AB12CD34EF56', text: '> on' })
    expect(parseCliReply(new Uint8Array([16, 20, 0, 0, ...body]))?.text).toBe('> on')
    const chat = [...body]
    chat[7] = 0
    expect(parseCliReply(new Uint8Array([7, ...chat]))).toBeNull()
    expect(cliValue('> on')).toBe('on')
    expect(cliValue('OK')).toBe('OK')
  })
})
