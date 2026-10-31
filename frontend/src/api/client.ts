import type {
  BBox,
  FeatureCollection,
  FramesResponse,
  Health,
  HistoryBucket,
  LinkKind,
  LinkDetail,
  LinkProfile,
  LinkProperties,
  NodeDetail,
  NodeProperties,
  NodeSearchHit,
  ServerConfig,
} from './types'

// Origin of the API, without /api and without a trailing slash. Empty means same origin.
const BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '')

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { signal, headers: { Accept: 'application/json' } })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) detail = body.error
    } catch {
      // keep the status text
    }
    throw new ApiError(`${path}: ${detail}`, res.status)
  }
  return (await res.json()) as T
}

function bboxParam(b: BBox | null): string {
  if (!b) return ''
  // The server expects minLng,minLat,maxLng,maxLat -- the GeoJSON axis order.
  return `bbox=${b.minLng.toFixed(5)},${b.minLat.toFixed(5)},${b.maxLng.toFixed(5)},${b.maxLat.toFixed(5)}`
}

export interface LinksQuery {
  bbox?: BBox | null
  kinds?: LinkKind[]
  minSamples?: number
  limit?: number
  /** Only these links (linkIds). */
  ids?: string[]
  /** Every property, as the link panel needs; otherwise what the map reads. */
  full?: boolean
}

/** One hop a companion measured, sent to POST /api/measurements. */
export interface MeasuredHop {
  from: string
  to: string
  snr: number
}

export interface MeasurementsReply {
  accepted: number
  skipped: Record<string, number>
}

/**
 * The map's slim links carry their id only as the feature id, "<aKey>:<bKey>"
 * (api/handlers.go mapLinkProps): put linkId, aKey and bKey back.
 */
function withLinkKeys(fc: FeatureCollection<LinkProperties>): FeatureCollection<LinkProperties> {
  for (const f of fc.features ?? []) {
    const id = (f as { id?: string }).id ?? f.properties.linkId
    if (!id) continue
    const [a, b] = id.split(':')
    f.properties.linkId ??= id
    f.properties.aKey ??= a!
    f.properties.bKey ??= b!
  }
  return fc
}

export const api = {
  /**
   * Sends what a companion measured (a trace's hops, or a discovery) so the
   * map gets every hop, not only those an observer heard. Needs the token.
   */
  submitMeasurements: async (
    token: string,
    body: { companion: string; source: 'trace' | 'discovery'; tag: number; at: string; hops: MeasuredHop[] },
  ): Promise<MeasurementsReply> => {
    const res = await fetch(`${BASE}/api/measurements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new ApiError(`/api/measurements: ${res.statusText}`, res.status)
    return (await res.json()) as MeasurementsReply
  },

  config: (signal?: AbortSignal) => get<ServerConfig>('/api/config', signal),

  health: (signal?: AbortSignal) => get<Health>('/api/health', signal),

  nodes: (bbox: BBox | null, signal?: AbortSignal) =>
    get<FeatureCollection<NodeProperties>>(`/api/nodes?${bboxParam(bbox)}`, signal),

  /** Nodes on the map whose name or key matches q, wherever they are. */
  searchNodes: (q: string, signal?: AbortSignal) =>
    get<{ nodes: NodeSearchHit[] }>(`/api/nodes/search?q=${encodeURIComponent(q)}`, signal),

  node: (key: string, signal?: AbortSignal) =>
    get<NodeDetail>(`/api/nodes/${encodeURIComponent(key)}`, signal),

  links: (q: LinksQuery, signal?: AbortSignal) => {
    const params = new URLSearchParams()
    if (q.kinds?.length) params.set('kind', q.kinds.join(','))
    if (q.minSamples) params.set('minSamples', String(q.minSamples))
    if (q.limit) params.set('limit', String(q.limit))
    if (q.ids?.length) params.set('ids', q.ids.join(','))
    if (q.full) params.set('fields', 'full')
    const bb = bboxParam(q.bbox ?? null)
    const qs = [bb, params.toString()].filter(Boolean).join('&')
    return get<FeatureCollection<LinkProperties>>(`/api/links?${qs}`, signal).then(withLinkKeys)
  },

  link: (linkId: string, signal?: AbortSignal) => {
    const [a, b] = linkId.split(':')
    return get<LinkDetail>(`/api/links/${a}/${b}`, signal)
  },

  /** Line of sight; antA / antB override the server's antenna height at each end (m). */
  profile: (linkId: string, heights: { antA?: number; antB?: number } = {}, signal?: AbortSignal) => {
    const [a, b] = linkId.split(':')
    const q = new URLSearchParams()
    if (heights.antA !== undefined) q.set('antA', String(heights.antA))
    if (heights.antB !== undefined) q.set('antB', String(heights.antB))
    const qs = q.toString()
    return get<LinkProfile>(`/api/links/${a}/${b}/profile${qs ? `?${qs}` : ''}`, signal)
  },

  frames: (linkId: string, limit = 10, signal?: AbortSignal) => {
    const [a, b] = linkId.split(':')
    return get<FramesResponse>(`/api/links/${a}/${b}/frames?limit=${limit}`, signal)
  },

  history: (linkId: string, window = '24h', bucket = '1h', signal?: AbortSignal) => {
    const [a, b] = linkId.split(':')
    return get<{ linkId: string; buckets: HistoryBucket[] }>(
      `/api/links/${a}/${b}/history?window=${window}&bucket=${bucket}`,
      signal,
    )
  },

  streamUrl: (linkId: string | null) =>
    `${BASE}/api/stream${linkId ? `?link=${encodeURIComponent(linkId)}` : ''}`,
}

export { ApiError }
