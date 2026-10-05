/**
 * SNR colour scale.
 *
 * SNR is a magnitude, so it gets an ORDINAL one-hue ramp: lightness carries the
 * order. The obvious alternative -- a red/orange/green "quality" scale -- was
 * measured and rejected: good green (#0ca30c) against critical red (#d03b3b)
 * is only 4.1 ΔE apart under simulated deuteranopia, so the map would be
 * unreadable for roughly 8% of men, and a map cannot label every line to
 * compensate. A single blue hue stepped dark→light survives every colour-vision
 * deficiency because luminance is intact in all of them.
 *
 * Both ramps pass the ordinal checks (monotone lightness, adjacent ΔL ≥ 0.06,
 * light end ≥ 2:1 against its own surface, single hue):
 *   light: steps 250/400/550/700, light end 2.06:1
 *   dark:  steps 150/300/450/600, light end 2.15:1
 *
 * Light = strong link: index 0 is the weakest bucket and the darkest step. The
 * white/black casing under every line keeps the light end legible over tiles.
 */

export const SNR_RAMP_LIGHT = ['#0d366b', '#1c5cab', '#3987e5', '#86b6ef'] as const
export const SNR_RAMP_DARK = ['#184f95', '#2a78d6', '#6da7ec', '#b7d3f6'] as const

/**
 * The blue ramp above is the default. 'traffic' is an opt-in red → green ramp
 * for readers used to that convention; it keeps lightness rising with the signal
 * so the order still reads without the hue. Mirrored as CSS variables in
 * theme.css under [data-palette='traffic'].
 */
export type SnrPalette = 'blue' | 'traffic'

export const SNR_RAMPS: Record<SnrPalette, { light: readonly string[]; dark: readonly string[] }> = {
  blue: { light: SNR_RAMP_LIGHT, dark: SNR_RAMP_DARK },
  traffic: {
    light: ['#b2182b', '#e66101', '#c99700', '#5fb236'],
    dark: ['#e34a33', '#fd8d3c', '#fecc5c', '#a6dba0'],
  },
}

function rampOf(dark: boolean, palette: SnrPalette): readonly string[] {
  return dark ? SNR_RAMPS[palette].dark : SNR_RAMPS[palette].light
}

/**
 * The "Fonctionnel" view drops the ramp: every link above the usable threshold
 * gets the same light blue, the question being only "does it work?".
 */
export const FUNCTIONAL_LIGHT = '#4f97ea'
export const FUNCTIONAL_DARK = '#9cc6f5'

/** The two ends of a selected link, as in the panel (--node-a / --node-b). */
export const NODE_A_LIGHT = '#b45309'
export const NODE_B_LIGHT = '#be185d'
export const NODE_A_DARK = '#fbbf24'
export const NODE_B_DARK = '#f472b6'

/** No measurement exists for a topology link, so it gets ink, not a 5th ramp step. */
export const NO_DATA_LIGHT = '#52514e'
export const NO_DATA_DARK = '#c3c2b7'

export const SURFACE_LIGHT = '#fcfcfb'
export const SURFACE_DARK = '#1a1a19'

/** Single-series accent for the sparkline (categorical slot 1). */
export const ACCENT_LIGHT = '#2a78d6'
export const ACCENT_DARK = '#3987e5'

/** Default bucket edges in dB; the server sends its own via /api/config. */
export const DEFAULT_SNR_THRESHOLDS = [-12, -5, 5] as const

export interface SnrBucket {
  /** Inclusive lower bound in dB, or -Infinity. */
  from: number
  /** Exclusive upper bound in dB, or Infinity. */
  to: number
  label: string
  /** Short operational reading, shown in the legend next to the dB range. */
  note: string
}

/**
 * Bucket labels. The ramp is ordinal, so the legend must spell out the dB range:
 * the colour alone is an ordering, not a value.
 */
export function snrBuckets(thresholds: readonly number[]): SnrBucket[] {
  const [t0, t1, t2] = thresholds
  // Same order as the ramp and snrBucketIndex: weakest first. Display order is
  // the legend's business.
  return [
    { from: -Infinity, to: t0!, label: `< ${t0} dB`, note: 'Intermittent' },
    { from: t0!, to: t1!, label: `${t0} à ${t1} dB`, note: 'Instable' },
    { from: t1!, to: t2!, label: `${t1} à ${t2} dB`, note: 'Utilisable' },
    { from: t2!, to: Infinity, label: `≥ ${t2} dB`, note: 'Lien stable à solide' },
  ]
}

/** Index of the bucket an SNR value falls in. */
export function snrBucketIndex(snr: number, thresholds: readonly number[]): number {
  let i = 0
  for (const t of thresholds) {
    if (snr < t) return i
    i++
  }
  return i
}

export function snrColor(
  snr: number,
  thresholds: readonly number[],
  dark: boolean,
  palette: SnrPalette = 'blue',
): string {
  const ramp = rampOf(dark, palette)
  return ramp[snrBucketIndex(snr, thresholds)] ?? ramp[ramp.length - 1]!
}

/**
 * A MapLibre `step` expression over the snrMedian property.
 *
 * Discrete buckets rather than a continuous `interpolate`: four steps with a
 * labelled legend are readable on a busy map, where a continuous ramp asks the
 * eye to decode a lightness it cannot measure against a moving basemap.
 */
export function snrStepExpression(
  thresholds: readonly number[],
  dark: boolean,
  property = 'snrMedian',
  palette: SnrPalette = 'blue',
): unknown[] {
  const ramp = rampOf(dark, palette)
  const expr: unknown[] = ['step', ['get', property], ramp[0]]
  thresholds.forEach((t, i) => {
    expr.push(t, ramp[i + 1] ?? ramp[ramp.length - 1])
  })
  return expr
}
