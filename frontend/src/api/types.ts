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
  /** The weaker direction's median; what the map colours by default. */
  snrQuality?: number
  /** What snrQuality rests on: both directions, one only, or too few samples in either. */
  snrBasis?: SnrBasis
  /** A → B is what B measured hearing A. */
  snrMedianAB?: number
  snrP10AB?: number
  snrCountAB?: number
  snrMedianBA?: number
  snrP10BA?: number
  snrCountBA?: number
  /** Median A → B minus median B → A, only when snrBasis is 'both'. */
  snrDelta?: number
  rssiMean?: number
  /** Mean RSSI per direction, like snrMedianAB / snrMedianBA. */
  rssiMeanAB?: number
  rssiMeanBA?: number
}

export type SnrBasis = 'both' | 'oneWay' | 'few'

export interface NodeProperties {
  key: string
  name: string
  nodeType: 'none' | 'companion' | 'repeater' | 'room' | 'sensor' | string
  /** Path hash width (bytes) the node uses, from its adverts; absent until one is seen. */
  pathHashSize?: number
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
  /** Gap between direction medians from which the asymmetry view highlights a link. */
  asymmetryThresholdDb?: number
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

/** How much the observed mesh depends on a node to stay connected. */
export type BackboneLevel = 'low' | 'medium' | 'high' | 'critical'

export interface NodeInfo {
  key: string
  name: string
  nodeType: NodeProperties['nodeType']
  lat: number | null
  lon: number | null
  pathHashSize?: number
}

export interface NodeNeighbor extends NodeInfo {
  linkId: string
  kind: LinkKind
  samples: number
  snrQuality: number | null
  snrBasis?: SnrBasis
  /** What this node measured hearing the neighbour. */
  snrToNode: number | null
  /** What the neighbour measured hearing this node. */
  snrFromNode: number | null
  distKm: number | null
  lastSeen: string
  ageSec: number
  community: number | null
}

export interface Backbone {
  degree: number
  community: number
  /** Distinct groups among the node and its neighbours. */
  communities: number
  betweenness: number
  betweennessRank: number
  articulation: boolean
  /** Sizes of the parts its removal would leave, largest first. */
  splitSizes: number[]
  level: BackboneLevel
  reasons: string[]
}

/** GET /api/links/{a}/{b}: the link and its two ends as the resolver knows them. */
export interface LinkDetail {
  link: { aKey: string; bKey: string; lastSeen: string }
  a: { Key: string; Name: string; Latitude: number | null; Longitude: number | null }
  b: { Key: string; Name: string; Latitude: number | null; Longitude: number | null }
  distKm?: number
}

export interface NodeDetail {
  node: NodeInfo
  neighbors: NodeNeighbor[]
  backbone?: Backbone
  graph: { nodes: number; links: number; communities: number }
  lastSeen?: string
  ageSec?: number
}

/** One point of a line-of-sight profile (GET /api/links/{a}/{b}/profile). */
export interface ProfileSample {
  /** Distance from node A, km. */
  d: number
  /** Ground plus the earth's bulge, m: what the radio path has to clear. */
  t: number
  /** Height of the straight antenna-to-antenna line, m. */
  l: number
  /** First Fresnel zone radius, m. */
  f: number
}

export type LosVerdict = 'clear' | 'partial' | 'blocked'

export interface LinkProfile {
  available: boolean
  /** Why it is unavailable: outside the elevation model, or too short. */
  reason?: 'no_coverage' | 'too_short'
  freqMHz?: number
  antennaM?: number
  result?: {
    distKm: number
    points: ProfileSample[]
    /** Smallest (line - terrain) / Fresnel radius: 1 = zone free, < 0 = blocked. */
    clearance: number
    verdict: LosVerdict
    worst: ProfileSample
  }
}
