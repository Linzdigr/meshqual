/**
 * The map view (centre and zoom) kept across reloads, per browser. Storage may
 * be unavailable or hold anything, so every access is guarded and checked.
 */
const VIEW_KEY = 'meshqual.mapView'

export interface MapView {
  center: [number, number]
  zoom: number
}

export function parseView(raw: string | null): MapView | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as { center?: unknown; zoom?: unknown }
    const c = v.center
    if (!Array.isArray(c) || c.length !== 2) return null
    const [lng, lat] = c as unknown[]
    const zoom = v.zoom
    if (typeof lng !== 'number' || typeof lat !== 'number' || typeof zoom !== 'number') return null
    if (!Number.isFinite(lng + lat + zoom) || Math.abs(lng) > 180 || Math.abs(lat) > 85) return null
    if (zoom < 0 || zoom > 22) return null
    return { center: [lng, lat], zoom }
  } catch {
    return null
  }
}

export function loadView(): MapView | null {
  try {
    return parseView(localStorage.getItem(VIEW_KEY))
  } catch {
    return null
  }
}

export function saveView(view: MapView) {
  try {
    const round = (v: number) => Math.round(v * 1e5) / 1e5
    localStorage.setItem(
      VIEW_KEY,
      JSON.stringify({ center: view.center.map(round), zoom: Math.round(view.zoom * 100) / 100 }),
    )
  } catch {}
}
