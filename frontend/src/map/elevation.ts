import type { BBox } from '@/api/types'

/**
 * Altitude as a colour ramp. Elevation comes from the AWS Open Data terrain
 * tiles (Terrarium encoding, worldwide, CORS open), drawn by MapLibre's
 * color-relief layer. The ramp is stretched over the altitudes actually in view,
 * so a flat region still shows its few metres of relief.
 */
export const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
export const TERRARIUM_ATTRIBUTION =
  'Altitude : <a href="https://registry.opendata.aws/terrain-tiles/">Terrain Tiles</a> (Mapzen, AWS)'
export const TERRARIUM_MAXZOOM = 15

/** Low to high: a thermal ramp, cold low ground to hot high ground. */
export const ALTITUDE_COLORS = [
  '#30123b',
  '#4669e8',
  '#1ac7c2',
  '#62fc6b',
  '#e2dc38',
  '#fd8a26',
  '#c42503',
] as const

export interface AltitudeRange {
  lo: number
  hi: number
}

/** Metres from one Terrarium pixel. */
export function terrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768
}

/**
 * The color-relief expression spreading the ramp evenly over [lo, hi]. Below lo
 * and above hi the end colours hold, which is what MapLibre's interpolate does.
 * The sea (negative in the tiles) stays clear so the coast reads at a glance.
 */
export function reliefColorExpression(range: AltitudeRange): unknown[] {
  const lo = Math.max(0, range.lo)
  const span = Math.max(range.hi - lo, 1)
  const expr: unknown[] = ['interpolate', ['linear'], ['elevation'], -0.5, 'rgba(0, 0, 0, 0)']
  ALTITUDE_COLORS.forEach((c, i) => {
    expr.push(lo + (span * i) / (ALTITUDE_COLORS.length - 1), c)
  })
  return expr
}

/**
 * The 2nd to 98th percentile of the samples, so one mast-top artefact or a sea
 * pixel does not flatten the ramp. Sea (negative bathymetry) counts as 0 m, and
 * the range is at least `minSpan` metres wide so a flat plain is not noise.
 */
export function stretch(samples: number[], minSpan = 20): AltitudeRange | null {
  if (samples.length === 0) return null
  const v = samples.map((s) => Math.max(0, s)).sort((a, b) => a - b)
  const at = (q: number) => v[Math.min(v.length - 1, Math.floor(q * (v.length - 1)))]!
  let lo = at(0.02)
  let hi = at(0.98)
  if (hi - lo < minSpan) {
    const mid = (lo + hi) / 2
    lo = Math.max(0, mid - minSpan / 2)
    hi = lo + minSpan
  }
  return { lo: Math.round(lo), hi: Math.round(hi) }
}

/** Web Mercator tile coordinates of a point, fractional. */
export function tileXY(lon: number, lat: number, z: number): [number, number] {
  const n = 2 ** z
  const rad = (lat * Math.PI) / 180
  return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n]
}

/**
 * The tiles covering a bounding box at a zoom chosen to keep the download small
 * (at most `maxTiles`), with the box in each tile's pixel space.
 */
export function coveringTiles(b: BBox, zoom: number, maxTiles = 16) {
  let z = Math.min(12, Math.max(3, Math.floor(zoom) - 1))
  for (;;) {
    const [x0, y0] = tileXY(b.minLng, b.maxLat, z)
    const [x1, y1] = tileXY(b.maxLng, b.minLat, z)
    const tx0 = Math.floor(x0)
    const ty0 = Math.floor(y0)
    const tx1 = Math.floor(x1)
    const ty1 = Math.floor(y1)
    const count = (tx1 - tx0 + 1) * (ty1 - ty0 + 1)
    if (count <= maxTiles || z <= 3) {
      const tiles: { z: number; x: number; y: number }[] = []
      for (let x = tx0; x <= tx1; x++) for (let y = ty0; y <= ty1; y++) tiles.push({ z, x, y })
      return { z, tiles, box: { x0, y0, x1, y1 } }
    }
    z--
  }
}

const tileCache = new Map<string, Promise<Float32Array | null>>()
const TILE_CACHE_MAX = 64

/** A tile slower than this counts as failed: one stalled request must not hold up the rest. */
const TILE_TIMEOUT_MS = 15_000

/**
 * Width, height and 8-bit RGB or RGBA samples of a PNG, decoded here rather
 * than read back from a canvas: browsers that fight fingerprinting (Safari,
 * Brave, Firefox resistFingerprinting) add noise to canvas readback, and one
 * unit off on a Terrarium red byte is 256 m off. Non-interlaced 8-bit RGB(A)
 * only, which is what Terrain Tiles serve.
 */
export async function decodePng(buf: ArrayBuffer): Promise<{ width: number; height: number; channels: 3 | 4; pixels: Uint8Array }> {
  const b = new Uint8Array(buf)
  const v = new DataView(buf)
  if (v.getUint32(0) !== 0x89504e47 || v.getUint32(4) !== 0x0d0a1a0a) throw new Error('not a PNG')
  let width = 0
  let height = 0
  let channels: 3 | 4 = 3
  const idat: Uint8Array[] = []
  for (let off = 8; off + 8 <= b.length; ) {
    const len = v.getUint32(off)
    const type = String.fromCharCode(b[off + 4]!, b[off + 5]!, b[off + 6]!, b[off + 7]!)
    if (type === 'IHDR') {
      width = v.getUint32(off + 8)
      height = v.getUint32(off + 12)
      const depth = b[off + 16]
      const color = b[off + 17]
      if (depth !== 8 || (color !== 2 && color !== 6) || b[off + 20] !== 0) throw new Error('unsupported PNG')
      channels = color === 2 ? 3 : 4
    } else if (type === 'IDAT') {
      idat.push(b.subarray(off + 8, off + 8 + len))
    } else if (type === 'IEND') {
      break
    }
    off += 12 + len
  }
  const packed = new Uint8Array(idat.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const c of idat) {
    packed.set(c, at)
    at += c.length
  }
  const ds = new DecompressionStream('deflate')
  const writer = ds.writable.getWriter()
  writer.write(packed).catch(() => {})
  writer.close().catch(() => {})
  const raw = new Uint8Array(await new Response(ds.readable).arrayBuffer())

  const stride = width * channels
  if (raw.length < height * (stride + 1)) throw new Error('truncated PNG')
  const out = new Uint8Array(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    const src = y * (stride + 1) + 1
    const o = y * stride
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? out[o + x - channels]! : 0
      const up = y > 0 ? out[o - stride + x]! : 0
      const diag = x >= channels && y > 0 ? out[o - stride + x - channels]! : 0
      let pred = 0
      if (filter === 1) pred = left
      else if (filter === 2) pred = up
      else if (filter === 3) pred = (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - diag
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - diag)
        pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : diag
      }
      out[o + x] = (raw[src + x]! + pred) & 0xff
    }
  }
  return { width, height, channels, pixels: out }
}

/** Decoded elevations of one 256×256 tile, or null when it fails to load. */
export function loadTile(z: number, x: number, y: number): Promise<Float32Array | null> {
  const url = TERRARIUM_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))
  let p = tileCache.get(url)
  if (!p) {
    p = (async () => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(TILE_TIMEOUT_MS) })
        if (!res.ok) return null
        const png = await decodePng(await res.arrayBuffer())
        const out = new Float32Array(png.width * png.height)
        const c = png.channels
        for (let i = 0; i < out.length; i++) out[i] = terrarium(png.pixels[i * c]!, png.pixels[i * c + 1]!, png.pixels[i * c + 2]!)
        return out
      } catch {
        // A network failure is worth another try later, unlike a missing tile.
        tileCache.delete(url)
        return null
      }
    })()
    if (tileCache.size >= TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value!)
    tileCache.set(url, p)
  }
  return p
}

/** The altitude range in view, sampled from the terrain tiles covering it. */
export async function viewRange(b: BBox, zoom: number): Promise<AltitudeRange | null> {
  const { tiles, box } = coveringTiles(b, zoom)
  const grids = await Promise.all(tiles.map((t) => loadTile(t.z, t.x, t.y)))
  const samples: number[] = []
  const step = 4 // one pixel in 16 is plenty for percentiles
  tiles.forEach((t, i) => {
    const g = grids[i]
    if (!g) return
    for (let py = 0; py < 256; py += step) {
      const ty = t.y + (py + 0.5) / 256
      if (ty < box.y0 || ty > box.y1) continue
      for (let px = 0; px < 256; px += step) {
        const tx = t.x + (px + 0.5) / 256
        if (tx < box.x0 || tx > box.x1) continue
        samples.push(g[py * 256 + px]!)
      }
    }
  })
  return stretch(samples)
}
