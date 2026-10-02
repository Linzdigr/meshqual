// Mirrors the Go API payloads. Kept hand-written and small rather than generated:
// the surface is five endpoints and the compiler catches a drift immediately.

/** How a link sample was obtained. Only two of the three carry a real measurement. */
export type LinkKind = 'topology' | 'measured' | 'trace'

export interface LinkProperties {
  linkId: string
  aKey: string
  bKey: string
  aName: string
  bName: string
  kind: LinkKind
  samples: number
  forward: number
  backward: number
  lastSeen: string
  ageSec: number
  /** Direction of the newest sample: true means A → B. */
  lastForward: boolean
  /** SNR carried by the newest sample, when it had one. */
  lastSnr?: number
  distKm: number
  /** log10(samples+1): the width channel, so a backbone does not hide the leaves. */
  weight: number
  snrMedian?: number
  snrP10?: number
  snrMin?: number
  snrMax?: number
  snrCount?: number
  rssiMean?: number
}

export interface NodeProperties {
  key: string
  name: string
  nodeType: 'none' | 'companion' | 'repeater' | 'room' | 'sensor' | string
}

export interface CollectionMeta {
  generatedAt: string
  window: string
  total: number
  returned: number
  truncated: boolean
  /** Links whose endpoints never advertised a position, so they cannot be drawn. */
  withoutPosition: number
  /** Share of observed hops that matched no known node. */
  unresolvedShare: number
  /** Share of observed hops whose path hash matched more than one node. */
  ambiguousShare: number
}

import type { Geometry } from 'geojson'

export interface Feature<P, G = Geometry> {
  type: 'Feature'
  id?: string
  geometry: G
  properties: P
}

export interface FeatureCollection<P> {
  type: 'FeatureCollection'
  features: Feature<P>[]
  meta?: CollectionMeta
}

export interface Frame {
  at: string
  kind: LinkKind
  forward: boolean
  snr: number | null
  rssi: number | null
  payloadType: string
  routeType: string
  hopIndex: number
  hopCount: number
  observerKey: string
  sourceId: string
  wireHash: string
}

export interface FramesResponse {
  linkId: string
  limit: number
  max: number
  frames: Frame[]
}

export interface HistoryBucket {
  bucket: string
  kind: LinkKind
  samples: number
  snrSamples: number
  snrAvg: number | null
  snrMin: number | null
  snrMax: number | null
  rssiAvg: number | null
}

export interface ServerConfig {
  pushIntervalMs: number
  liveWindow: string
  framesMax: number
  /** Three edges defining four SNR buckets, in dB. */
  snrThresholds: [number, number, number] | number[]
  snrRange: [number, number] | number[]
}

export interface SourceStats {
  id: string
  kind: string
  connected: boolean
  received: number
  dropped: number
  decodeErrors: number
  lastMessageAt: string | null
  lastError?: string
}

export interface Health {
  version: string
  uptimeSeconds: number
  database: { ok: boolean }
  nodes: number
  attribution: {
    links: number
    samples: number
    hopsTotal: number
    hopsUnresolved: number
    hopsAmbiguous: number
    unresolvedShare: number
    ambiguousShare: number
  }
  pipeline: { decoded: number; decodeErrors: number; written: number; writeErrors: number }
  sources: SourceStats[]
  sse: { clients: number; dropped: number }
}

export interface BBox {
  minLng: number
  minLat: number
  maxLng: number
  maxLat: number
}
