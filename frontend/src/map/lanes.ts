import type { LineString } from 'geojson'
import type { Feature, FeatureCollection, LinkProperties } from '@/api/types'

/** How links are drawn: one line per link, or one lane per direction. */
export type ViewMode = 'quality' | 'asymmetry' | 'functional'

export interface LaneProperties {
  /** `${linkId}:ab` or `${linkId}:ba`. */
  laneId: string
  linkId: string
  /** Median SNR of this direction; absent when the direction was never measured. */
  snr?: number
  measured: boolean
  /** The link is asymmetric beyond the threshold: drawn at full opacity. */
  emphasized: boolean
}

export function laneId(linkId: string, forward: boolean): string {
  return `${linkId}:${forward ? 'ab' : 'ba'}`
}

/**
 * Usable both ways: each direction is measured and the weaker one reaches the
 * usable bucket (the second SNR threshold, -5 dB by default). A link measured
 * one way only says nothing about the way back, so it does not qualify.
 * Mirrored as a MapLibre filter by functionalFilter in useMapLibre.ts.
 */
export function isFunctional(p: LinkProperties, thresholds: readonly number[]): boolean {
  return p.snrBasis === 'both' && (p.snrQuality ?? -Infinity) >= (thresholds[1] ?? -5)
}

/** Both directions are measured and their medians differ by at least `thresholdDb`. */
export function isAsymmetric(p: LinkProperties, thresholdDb: number): boolean {
  return p.snrBasis === 'both' && p.snrDelta !== undefined && Math.abs(p.snrDelta) >= thresholdDb
}

/**
 * Two lanes per link that has any SNR, one per direction of transmission.
 *
 * Each lane's geometry runs in its direction of travel, so a positive MapLibre
 * `line-offset` puts it on the right-hand side of that direction, like traffic
 * on a two-way road. Topology links have no SNR either way and get no lanes.
 */
export function buildLanes(
  fc: FeatureCollection<LinkProperties>,
  thresholdDb: number,
): FeatureCollection<LaneProperties> {
  const features: Feature<LaneProperties, LineString>[] = []
  for (const f of fc.features) {
    const p = f.properties
    if (p.kind === 'topology' || f.geometry.type !== 'LineString') continue
    const coords = f.geometry.coordinates
    const emphasized = isAsymmetric(p, thresholdDb)
    const lane = (forward: boolean, median?: number, count?: number) => {
      const measured = (count ?? 0) > 0 && median !== undefined
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: forward ? coords : [...coords].reverse() },
        properties: {
          laneId: laneId(p.linkId, forward),
          linkId: p.linkId,
          measured,
          emphasized,
          ...(measured && { snr: median }),
        },
      })
    }
    lane(true, p.snrMedianAB, p.snrCountAB)
    lane(false, p.snrMedianBA, p.snrCountBA)
  }
  return { type: 'FeatureCollection', features }
}
