import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { decodePng, terrarium } from './elevation'

function crc32(b: Uint8Array): number {
  let c = ~0
  for (const x of b) {
    c ^= x
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length)
  const v = new DataView(out.buffer)
  v.setUint32(0, body.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(body, 8)
  v.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)))
  return out
}

/** An RGB PNG of `px`, row y filtered with filter type y % 5. */
function encode(w: number, h: number, px: Uint8Array): ArrayBuffer {
  const stride = w * 3
  const raw = new Uint8Array(h * (stride + 1))
  for (let y = 0; y < h; y++) {
    const f = y % 5
    raw[y * (stride + 1)] = f
    for (let x = 0; x < stride; x++) {
      const cur = px[y * stride + x]!
      const left = x >= 3 ? px[y * stride + x - 3]! : 0
      const up = y > 0 ? px[(y - 1) * stride + x]! : 0
      const diag = x >= 3 && y > 0 ? px[(y - 1) * stride + x - 3]! : 0
      const p = left + up - diag
      const paeth = Math.abs(p - left) <= Math.abs(p - up) && Math.abs(p - left) <= Math.abs(p - diag) ? left : Math.abs(p - up) <= Math.abs(p - diag) ? up : diag
      const pred = [0, left, up, (left + up) >> 1, paeth][f]!
      raw[y * (stride + 1) + 1 + x] = (cur - pred) & 0xff
    }
  }
  const ihdr = new Uint8Array(13)
  new DataView(ihdr.buffer).setUint32(0, w)
  new DataView(ihdr.buffer).setUint32(4, h)
  ihdr.set([8, 2, 0, 0, 0], 8)
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)]
  // Split the data over two IDAT chunks, as encoders do.
  const z = new Uint8Array(deflateSync(raw))
  const cut = z.length >> 1
  parts.push(chunk('IDAT', z.subarray(0, cut)), chunk('IDAT', z.subarray(cut)), chunk('IEND', new Uint8Array()))
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out.buffer
}

describe('decodePng', () => {
  it('undoes every row filter, exactly', async () => {
    const w = 7
    const h = 10
    const px = new Uint8Array(w * h * 3)
    for (let i = 0; i < px.length; i++) px[i] = (i * 37 + ((i * i) % 251)) & 0xff
    const png = await decodePng(encode(w, h, px))
    expect([png.width, png.height, png.channels]).toEqual([w, h, 3])
    expect([...png.pixels]).toEqual([...px])
  })

  it('reads Terrarium metres back', async () => {
    // 102.5 m and -3 m: red 128 and 127.
    const px = new Uint8Array([128, 102, 128, 127, 253, 0])
    const png = await decodePng(encode(2, 1, px))
    expect(terrarium(png.pixels[0]!, png.pixels[1]!, png.pixels[2]!)).toBe(102.5)
    expect(terrarium(png.pixels[3]!, png.pixels[4]!, png.pixels[5]!)).toBe(-3)
  })
})
