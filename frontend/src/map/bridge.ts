import type { ExpressionSpecification } from 'maplibre-gl'

/**
 * The "Rôle de pont" layer: how much the observed mesh depends on each node to
 * stay connected (api topo analysis), shown by the node's size and fill. One
 * warm hue, ordered by lightness, so it stays readable without colour vision
 * and never mixes with the links' blue SNR ramp. The most important nodes are
 * the most visible: darker on the light map, brighter on the dark one.
 */
export type BridgeLevel = 'low' | 'medium' | 'high' | 'critical'

export const BRIDGE_LEVELS: { id: BridgeLevel; label: string; hint: string }[] = [
  { id: 'critical', label: 'Critique', hint: 'sa perte coupe le réseau en groupes' },
  { id: 'high', label: 'Élevé', hint: 'relie des groupes ou porte beaucoup de chemins' },
  { id: 'medium', label: 'Moyen', hint: 'quelques chemins passent par lui' },
  { id: 'low', label: 'Faible', hint: "d'autres chemins existent" },
]

const FILL_LIGHT: Record<BridgeLevel, string> = {
  low: '#ffffff',
  medium: '#fdba74',
  high: '#f97316',
  critical: '#9a3412',
}
const FILL_DARK: Record<BridgeLevel, string> = {
  low: '#2a2a28',
  medium: '#9a3412',
  high: '#ea580c',
  critical: '#fed7aa',
}

export const bridgeFill = (level: BridgeLevel, dark: boolean) => (dark ? FILL_DARK : FILL_LIGHT)[level]

/** Radius in px at zooms 5 and 12. */
export const BRIDGE_RADIUS: Record<BridgeLevel, [number, number]> = {
  low: [2, 4],
  medium: [3, 5.5],
  high: [4.5, 8],
  critical: [6, 11],
}

const byLevel = (pick: (l: BridgeLevel) => string | number, fallback: string | number): ExpressionSpecification => [
  'match',
  ['get', 'bridge'],
  'medium',
  pick('medium'),
  'high',
  pick('high'),
  'critical',
  pick('critical'),
  fallback,
]

export function bridgeRadiusExpression(): ExpressionSpecification {
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    5,
    byLevel((l) => BRIDGE_RADIUS[l][0], BRIDGE_RADIUS.low[0]),
    12,
    byLevel((l) => BRIDGE_RADIUS[l][1], BRIDGE_RADIUS.low[1]),
  ]
}

export function bridgeFillExpression(dark: boolean): ExpressionSpecification {
  return byLevel((l) => bridgeFill(l, dark), bridgeFill('low', dark))
}

/** While the layer is on, links step back so the nodes carry the view. */
export const BRIDGE_LINK_DIM = 0.35
