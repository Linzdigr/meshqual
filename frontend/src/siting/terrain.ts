/**
 * Ground elevation and radio reach between two points, from Terrarium tiles
 * already decoded (map/elevation). Pure: runs in the siting worker.
 */

export interface DemTile {
  x: number
  y: number
  data: Float32Array
}

/** Decoded elevation tiles at one zoom, 256×256 metres per tile. */
export interface DemGrid {
  z: number
  tiles: DemTile[]
}

export interface Point {
  lon: number
  lat: number
}

const EARTH_M = 6_371_000
/** Effective earth radius for radio (k = 4/3), as in the line-of-sight panel. */
const K_EARTH_M = (4 / 3) * EARTH_M
/** The mesh's frequency (EU 869.525 MHz) and its wavelength. */
export const FREQ_MHZ = 869.525
const LAMBDA_M = 299.792458 / FREQ_MHZ

export function distanceM(a: Point, b: Point): number {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

export class Dem {
  private readonly tiles = new Map<string, Float32Array>()
  private readonly n: number

  constructor(readonly grid: DemGrid) {
    this.n = 2 ** grid.z
    for (const t of grid.tiles) this.tiles.set(`${t.x}/${t.y}`, t.data)
  }

  /** Metres at a point (nearest pixel), or null outside the loaded tiles. */
  at(lon: number, lat: number): number | null {
    const rad = (lat * Math.PI) / 180
    const fx = ((lon + 180) / 360) * this.n
    const fy = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * this.n
    const tx = Math.floor(fx)
    const ty = Math.floor(fy)
    const data = this.tiles.get(`${tx}/${ty}`)
    if (!data) return null
    const px = Math.min(255, Math.floor((fx - tx) * 256))
    const py = Math.min(255, Math.floor((fy - ty) * 256))
    return data[py * 256 + px]!
  }
}

export interface Reach {
  distKm: number
  /** Free-space loss plus the diffraction of the worst obstacle, in dB. */
  lossDb: number
  /**
   * The tightest clearance along the path, in first-Fresnel radii: 0.6 or
   * more is clear, 0 grazes the line, negative is below it.
   */
  clearance: number
}

/** Free-space path loss at FREQ_MHZ. */
export function fsplDb(distKm: number): number {
  return 32.44 + 20 * Math.log10(Math.max(distKm, 0.01)) + 20 * Math.log10(FREQ_MHZ)
}

/** Single knife-edge diffraction loss for the Fresnel-Kirchhoff parameter v (ITU-R P.526). */
export function knifeEdgeDb(v: number): number {
  if (v <= -0.78) return 0
  return 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1)
}

/**
 * Radio reach between two antennas, `ha` and `hb` metres above the ground,
 * over the bare-earth profile: no buildings, no trees. The worst obstacle
 * alone sets the diffraction (one knife edge), which flatters paths crossing
 * several ridges.
 */
export function reach(dem: Dem, a: Point, b: Point, ha: number, hb: number): Reach | null {
  const d = distanceM(a, b)
  const ga = dem.at(a.lon, a.lat)
  const gb = dem.at(b.lon, b.lat)
  if (ga === null || gb === null || d < 1) return null
  const top = Math.max(0, ga) + ha
  const end = Math.max(0, gb) + hb
  const steps = Math.max(16, Math.min(200, Math.round(d / 100)))
  let vMax = -Infinity
  let clearance = Infinity
  for (let i = 1; i < steps; i++) {
    const t = i / steps
    const g = dem.at(a.lon + (b.lon - a.lon) * t, a.lat + (b.lat - a.lat) * t)
    if (g === null) continue
    const d1 = d * t
    const d2 = d - d1
    const bulge = (d1 * d2) / (2 * K_EARTH_M)
    const obstacle = Math.max(0, g) + bulge
    const line = top + (end - top) * t
    const r1 = Math.sqrt((LAMBDA_M * d1 * d2) / d)
    const h = obstacle - line
    vMax = Math.max(vMax, (Math.SQRT2 * h) / r1)
    clearance = Math.min(clearance, -h / r1)
  }
  const distKm = d / 1000
  return {
    distKm,
    lossDb: fsplDb(distKm) + knifeEdgeDb(vMax),
    clearance: Number.isFinite(clearance) ? clearance : 1,
  }
}
