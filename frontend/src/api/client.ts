import type {
  BBox,
  FeatureCollection,
  FramesResponse,
  Health,
  HistoryBucket,
  LinkKind,
  LinkProperties,
  NodeProperties,
  ServerConfig,
} from './types'

const BASE = import.meta.env.VITE_API_BASE ?? ''

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
}

export const api = {
  config: (signal?: AbortSignal) => get<ServerConfig>('/api/config', signal),

  health: (signal?: AbortSignal) => get<Health>('/api/health', signal),

  nodes: (bbox: BBox | null, signal?: AbortSignal) =>
    get<FeatureCollection<NodeProperties>>(`/api/nodes?${bboxParam(bbox)}`, signal),

  links: (q: LinksQuery, signal?: AbortSignal) => {
    const params = new URLSearchParams()
    if (q.kinds?.length) params.set('kind', q.kinds.join(','))
    if (q.minSamples) params.set('minSamples', String(q.minSamples))
    if (q.limit) params.set('limit', String(q.limit))
    const bb = bboxParam(q.bbox ?? null)
    const qs = [bb, params.toString()].filter(Boolean).join('&')
    return get<FeatureCollection<LinkProperties>>(`/api/links?${qs}`, signal)
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
