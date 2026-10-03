import maplibregl, { type ExpressionSpecification, type Map as MlMap, type StyleSpecification } from 'maplibre-gl'
import { onScopeDispose, type Ref } from 'vue'
import type { LineString } from 'geojson'
import type { BBox, Feature, FeatureCollection, LinkProperties, NodeProperties } from '@/api/types'
import {
  NO_DATA_DARK,
  NO_DATA_LIGHT,
  SURFACE_DARK,
  SURFACE_LIGHT,
  snrStepExpression,
  type SnrPalette,
} from '@/styles/scale'
import { buildLanes, isAsymmetric, laneId, type ViewMode } from '@/map/lanes'

export const LINKS_SOURCE = 'links'
export const NODES_SOURCE = 'nodes'
/** Links heard in the last ACTIVE_MS, oriented in the direction of their newest packet. */
export const ACTIVE_SOURCE = 'links-active'
/** One lane per direction of each link, for the asymmetry view (see map/lanes.ts). */
export const LANES_SOURCE = 'lanes'

const LAYER_CASING = 'links-casing'
const LAYER_TOPOLOGY = 'links-topology'
const LAYER_MEASURED = 'links-measured'
const LAYER_LANES = 'lanes-measured'
const LAYER_LANES_MISSING = 'lanes-missing'
const LAYER_LANE_ARROWS = 'lanes-arrows'
const LAYER_ACTIVE = 'links-active-line'
const LAYER_SELECTED = 'links-selected'
const LAYER_NODES = 'nodes-circles'
const LAYER_NODE_SELECTED = 'nodes-selected'
const LAYER_NODE_LABELS = 'nodes-labels'

/**
 * Tile source. OpenStreetMap's own tiles carry a usage policy that forbids
 * heavy automated use, so point this at your own raster cache before putting the
 * map in front of a group.
 * https://tile.openstreetmap.org
 */
const TILE_URL =
  import.meta.env.VITE_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'

const EMPTY_FC = { type: 'FeatureCollection', features: [] } as const

/** How long a link animates after its newest packet. */
const ACTIVE_MS = 10_000

/**
 * Ant-path frames for `line-dasharray`, in line-width units: a 3-long dash every
 * 7. Growing the leading gap frame by frame moves the dashes toward the end of
 * the line, so the geometry's direction is the direction of travel.
 */
const DASH_FRAMES: number[][] = [
  [0, 4, 3],
  [0.5, 4, 2.5],
  [1, 4, 2],
  [1.5, 4, 1.5],
  [2, 4, 1],
  [2.5, 4, 0.5],
  [3, 4, 0],
  [0, 0.5, 3, 3.5],
  [0, 1, 3, 3],
  [0, 1.5, 3, 2.5],
  [0, 2, 3, 2],
  [0, 2.5, 3, 1.5],
  [0, 3, 3, 1],
  [0, 3.5, 3, 0.5],
]
const DASH_FRAME_MS = 50

const TOPOLOGY_FILTER: ExpressionSpecification = ['==', ['get', 'kind'], 'topology']
const MEASURED_FILTER: ExpressionSpecification = ['!=', ['get', 'kind'], 'topology']

interface ActiveProperties {
  linkId: string
  /** The lane of the newest packet's direction, hidden while this one animates. */
  laneId: string
  /** Whether the link is drawn as lanes in the asymmetry view (not topology). */
  lanes: boolean
  emphasized: boolean
  weight: number
  /** SNR of the newest packet, else its direction's median, else the link quality. */
  snrActive?: number
}

const CHEVRON = 'chevron'

/**
 * Width is driven by traffic on a log scale (`weight` = log10(samples+1)): a
 * backbone link carries orders of magnitude more than a leaf, and a linear width
 * would collapse everything but the busiest pair into a hairline.
 *
 * MapLibre requires a `zoom` expression to be the input of a TOP-LEVEL step or
 * interpolate, so the extra width of the casing and the selection ring is baked
 * into the inner outputs rather than wrapped in an arithmetic expression.
 */
function widthAt(zoom: 5 | 11, extra: number): ExpressionSpecification {
  const [lo, hi] = zoom === 5 ? [0.8, 2.5] : [1.6, 6]
  return ['interpolate', ['linear'], ['get', 'weight'], 0, lo + extra, 4, hi + extra]
}

function widthExpr(extra = 0): ExpressionSpecification {
  return ['interpolate', ['linear'], ['zoom'], 5, widthAt(5, extra), 11, widthAt(11, extra)]
}

const WIDTH = widthExpr()

/*
 * Asymmetry view geometry. Lanes have a fixed width per zoom (traffic no longer
 * drives it) so the direction chevrons can sit exactly on them. Each lane is
 * offset by half its width plus a 0.5px gap, to the right of its direction.
 */
type LaneStops = { 5: number; 11: number; 15: number }
const LANE_WIDTH_AT: LaneStops = { 5: 1.5, 11: 3.5, 15: 6 }
const LANE_OFFSET_AT: LaneStops = { 5: 1.25, 11: 2.25, 15: 3.5 }
/** Both lanes plus a 1.5px surface ring each side. */
const LANE_CASING_AT: LaneStops = { 5: 7, 11: 11, 15: 16 }
const LANE_SELECTED_AT: LaneStops = LANE_CASING_AT

/**
 * Zoom-interpolated: `lanes` stops where `hasLanes` holds, else `otherwise` or
 * the traffic width. The zoom has to stay the top-level input, so the per-feature
 * case goes inside each stop.
 */
function laneAware(
  hasLanes: ExpressionSpecification,
  lanes: LaneStops,
  extra: number,
  otherwise?: number,
): ExpressionSpecification {
  // Traffic widths stop growing at zoom 11; lanes keep growing to 15.
  const other = (z: 5 | 11) => otherwise ?? widthAt(z, extra)
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    5,
    ['case', hasLanes, lanes[5], other(5)],
    11,
    ['case', hasLanes, lanes[11], other(11)],
    15,
    ['case', hasLanes, lanes[15], other(11)],
  ]
}

function laneStops(stops: LaneStops): ExpressionSpecification {
  return ['interpolate', ['linear'], ['zoom'], 5, stops[5], 11, stops[11], 15, stops[15]]
}

const LINK_HAS_LANES: ExpressionSpecification = ['!=', ['get', 'kind'], 'topology']
const ACTIVE_HAS_LANES: ExpressionSpecification = ['==', ['get', 'lanes'], true]
const LANE_WIDTH = laneStops(LANE_WIDTH_AT)
const LANE_OFFSET = laneStops(LANE_OFFSET_AT)
/**
 * Chevrons are drawn 10px tall and scaled with the lane. `icon-offset` is in
 * icon units, so the lane offset is divided by the icon size at each stop.
 */
const CHEVRON_SIZE_AT = { 10: 0.45, 15: 0.8 } as const
const CHEVRON_SIZE: ExpressionSpecification = [
  'interpolate',
  ['linear'],
  ['zoom'],
  10,
  CHEVRON_SIZE_AT[10],
  15,
  CHEVRON_SIZE_AT[15],
]
// Lane offset at zoom 10, interpolated between the 5 and 11 stops.
const LANE_OFFSET_Z10 = LANE_OFFSET_AT[5] + ((LANE_OFFSET_AT[11] - LANE_OFFSET_AT[5]) * 5) / 6
const CHEVRON_OFFSET: ExpressionSpecification = [
  'interpolate',
  ['linear'],
  ['zoom'],
  10,
  ['literal', [0, LANE_OFFSET_Z10 / CHEVRON_SIZE_AT[10]]],
  15,
  ['literal', [0, LANE_OFFSET_AT[15] / CHEVRON_SIZE_AT[15]]],
]
const EMPHASIZED: ExpressionSpecification = ['==', ['get', 'emphasized'], true]

/**
 * Opacity of every link layer, set in one place (applyFocus) because selecting
 * a link fades all the others: the selected link is drawn at full opacity and
 * the rest drops to FOCUS_DIM, so it reads on its own against the map.
 */
const FOCUS_DIM = 0.07
const NODE_FOCUS_DIM = 0.25

/** A right-pointing chevron in white, used as an SDF icon tinted per theme. */
function chevronImage(): ImageData {
  const px = 20 // 10 CSS px at pixelRatio 2
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = px
  const ctx = canvas.getContext('2d')!
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 4
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(6, 3)
  ctx.lineTo(14, 10)
  ctx.lineTo(6, 17)
  ctx.stroke()
  return ctx.getImageData(0, 0, px, px)
}

/** Clicking a 2px line demands pixel precision nobody has; query a padded box. */
const CLICK_TOLERANCE = 6

function baseStyle(dark: boolean): StyleSpecification {
  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      osm: {
        type: 'raster',
        tiles: [TILE_URL],
        tileSize: 256,
        maxzoom: 19,
        attribution: '&copy; OpenStreetMap contributors',
      },
      [LINKS_SOURCE]: { type: 'geojson', data: EMPTY_FC as never },
      [NODES_SOURCE]: { type: 'geojson', data: EMPTY_FC as never },
      [ACTIVE_SOURCE]: { type: 'geojson', data: EMPTY_FC as never },
      [LANES_SOURCE]: { type: 'geojson', data: EMPTY_FC as never },
    },
    layers: [
      {
        id: 'basemap',
        type: 'raster',
        source: 'osm',
        paint: {
          // The basemap is context, not data. Desaturating it keeps the one
          // encoded hue on the map the link colour.
          'raster-saturation': -0.75,
          'raster-opacity': dark ? 0.45 : 0.75,
          'raster-brightness-min': dark ? 0.0 : 0.15,
          'raster-brightness-max': dark ? 0.55 : 1,
        },
      },
    ],
  }
}

function dataLayers(dark: boolean, thresholds: readonly number[], palette: SnrPalette) {
  const surface = dark ? SURFACE_DARK : SURFACE_LIGHT
  const noData = dark ? NO_DATA_DARK : NO_DATA_LIGHT

  return [
    // A surface-coloured casing under every line. Map tiles are a busy, uneven
    // background, so without it the lighter ramp steps disappear over pale
    // terrain and the darker ones over forest.
    {
      id: LAYER_CASING,
      type: 'line' as const,
      source: LINKS_SOURCE,
      layout: { 'line-cap': 'round' as const, 'line-join': 'round' as const },
      paint: {
        'line-color': surface,
        'line-width': widthExpr(3),
      },
    },
    // The selection is a halo under the lines, so the selected link keeps its
    // own colours (and both lanes in the asymmetry view).
    {
      id: LAYER_SELECTED,
      type: 'line' as const,
      source: LINKS_SOURCE,
      filter: ['==', ['get', 'linkId'], '__none__'] as ExpressionSpecification,
      layout: { 'line-cap': 'round' as const, 'line-join': 'round' as const },
      paint: {
        'line-color': dark ? '#ffffff' : '#0b0b0b',
        'line-width': widthExpr(2.5),
        'line-opacity': 0.9,
      },
    },
    // Topology links: the pair demonstrably hear each other, but no signal
    // measurement exists for them. Dashed and in ink, never a ramp step, so the
    // map cannot imply a quality it does not have.
    {
      id: LAYER_TOPOLOGY,
      type: 'line' as const,
      source: LINKS_SOURCE,
      filter: TOPOLOGY_FILTER,
      layout: { 'line-cap': 'butt' as const, 'line-join': 'round' as const },
      paint: {
        'line-color': noData,
        'line-width': WIDTH,
        'line-dasharray': [2, 2] as unknown as ExpressionSpecification,
      },
    },
    // Measured and trace links: a real SNR, on the validated ordinal ramp,
    // taken from the weaker direction (snrQuality).
    {
      id: LAYER_MEASURED,
      type: 'line' as const,
      source: LINKS_SOURCE,
      filter: MEASURED_FILTER,
      layout: { 'line-cap': 'round' as const, 'line-join': 'round' as const },
      paint: {
        'line-color': snrStepExpression(thresholds, dark, 'snrQuality', palette) as unknown as ExpressionSpecification,
        'line-width': WIDTH,
      },
    },
    // Asymmetry view: one lane per direction, coloured by that direction's
    // median. Hidden in the quality view (see applyView). A direction never
    // measured is a thin dashed ink lane rather than an invented colour.
    {
      id: LAYER_LANES_MISSING,
      type: 'line' as const,
      source: LANES_SOURCE,
      filter: ['==', ['get', 'measured'], false] as ExpressionSpecification,
      layout: { 'line-cap': 'butt' as const, 'line-join': 'round' as const, visibility: 'none' as const },
      paint: {
        'line-color': noData,
        'line-width': 1,
        'line-offset': LANE_OFFSET,
        'line-dasharray': [2, 2] as unknown as ExpressionSpecification,
      },
    },
    {
      id: LAYER_LANES,
      type: 'line' as const,
      source: LANES_SOURCE,
      filter: ['==', ['get', 'measured'], true] as ExpressionSpecification,
      layout: { 'line-cap': 'butt' as const, 'line-join': 'round' as const, visibility: 'none' as const },
      paint: {
        'line-color': snrStepExpression(thresholds, dark, 'snr', palette) as unknown as ExpressionSpecification,
        'line-width': LANE_WIDTH,
        'line-offset': LANE_OFFSET,
      },
    },
    // Chevrons in surface colour, cut into each lane, pointing its way.
    {
      id: LAYER_LANE_ARROWS,
      type: 'symbol' as const,
      source: LANES_SOURCE,
      minzoom: 10,
      layout: {
        visibility: 'none' as const,
        'symbol-placement': 'line' as const,
        'symbol-spacing': 90,
        'icon-image': CHEVRON,
        'icon-size': CHEVRON_SIZE,
        'icon-offset': CHEVRON_OFFSET,
        'icon-rotation-alignment': 'map' as const,
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: {
        'icon-color': ['case', ['==', ['get', 'measured'], true], surface, noData] as ExpressionSpecification,
      },
    },
    // Recently heard links, animated in the direction of their newest packet.
    // The static line underneath is hidden meanwhile (see syncActive), so the
    // dash gaps show the casing rather than the same colour.
    {
      id: LAYER_ACTIVE,
      type: 'line' as const,
      source: ACTIVE_SOURCE,
      layout: { 'line-cap': 'butt' as const, 'line-join': 'round' as const },
      paint: {
        'line-color': [
          'case',
          ['has', 'snrActive'],
          snrStepExpression(thresholds, dark, 'snrActive', palette),
          noData,
        ] as unknown as ExpressionSpecification,
        'line-width': widthExpr(1),
        'line-dasharray': DASH_FRAMES[0] as unknown as ExpressionSpecification,
      },
    },
    {
      id: LAYER_NODES,
      type: 'circle' as const,
      source: NODES_SOURCE,
      paint: {
        'circle-radius': [
          'interpolate',
          ['linear'],
          ['zoom'],
          5,
          ['case', ['==', ['get', 'nodeType'], 'repeater'], 3, 2],
          12,
          ['case', ['==', ['get', 'nodeType'], 'repeater'], 6, 4],
        ] as unknown as ExpressionSpecification,
        'circle-color': dark ? SURFACE_DARK : SURFACE_LIGHT,
        'circle-stroke-width': 2,
        'circle-stroke-color': dark ? NO_DATA_DARK : NO_DATA_LIGHT,
      },
    },
    // A ring around the selected node, in text ink like the link selection.
    {
      id: LAYER_NODE_SELECTED,
      type: 'circle' as const,
      source: NODES_SOURCE,
      filter: ['==', ['get', 'key'], '__none__'] as ExpressionSpecification,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 7, 12, 11] as ExpressionSpecification,
        'circle-color': 'rgba(0, 0, 0, 0)',
        'circle-stroke-width': 2.5,
        'circle-stroke-color': dark ? '#ffffff' : '#0b0b0b',
      },
    },
    {
      id: LAYER_NODE_LABELS,
      type: 'symbol' as const,
      source: NODES_SOURCE,
      minzoom: 8,
      layout: {
        'text-field': ['get', 'name'] as unknown as ExpressionSpecification,
        'text-size': 11,
        'text-offset': [0, 1.1] as [number, number],
        'text-anchor': 'top' as const,
        'text-allow-overlap': false,
      },
      paint: {
        // Labels wear text ink, never a series colour.
        'text-color': dark ? '#ffffff' : '#0b0b0b',
        'text-halo-color': dark ? SURFACE_DARK : SURFACE_LIGHT,
        'text-halo-width': 1.4,
      },
    },
  ]
}

/** Unfocused opacity per link layer. Symmetric lanes recede so asymmetric ones stand out. */
const LINK_OPACITY: { layer: string; prop: 'line-opacity' | 'icon-opacity'; base: unknown }[] = [
  { layer: LAYER_CASING, prop: 'line-opacity', base: 0.85 },
  { layer: LAYER_TOPOLOGY, prop: 'line-opacity', base: 0.45 },
  { layer: LAYER_MEASURED, prop: 'line-opacity', base: 0.95 },
  { layer: LAYER_LANES_MISSING, prop: 'line-opacity', base: ['case', EMPHASIZED, 0.9, 0.4] },
  { layer: LAYER_LANES, prop: 'line-opacity', base: ['case', EMPHASIZED, 1, 0.4] },
  { layer: LAYER_LANE_ARROWS, prop: 'icon-opacity', base: ['case', EMPHASIZED, 1, 0.5] },
  { layer: LAYER_ACTIVE, prop: 'line-opacity', base: 1 },
]

export interface Padding {
  top: number
  right: number
  bottom: number
  left: number
}

export interface UseMapOptions {
  container: Ref<HTMLElement | null>
  dark: Ref<boolean>
  thresholds: Ref<number[]>
  mode: Ref<ViewMode>
  /** Asymmetry view only: hide every link that is not asymmetric. */
  asymOnly: Ref<boolean>
  asymThreshold: Ref<number>
  palette: Ref<SnrPalette>
  center?: [number, number]
  zoom?: number
  onMoveEnd: (bbox: BBox) => void
  onSelectLink: (linkId: string | null) => void
  onSelectNode: (key: string | null) => void
}

export function useMapLibre(opts: UseMapOptions) {
  let map: MlMap | null = null
  let ready = false
  let pendingLinks: FeatureCollection<LinkProperties> | null = null
  let pendingNodes: FeatureCollection<NodeProperties> | null = null

  const active = new Map<string, { expiresAt: number; feature: Feature<ActiveProperties, LineString> }>()
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  let raf = 0
  let dashFrame = 0
  let lastDashAt = 0
  /** Links asymmetric beyond the threshold, for the "asymmetric only" filter. */
  let emphasizedIds: string[] = []
  /** The selected link and its two ends, which stay opaque while the rest fades. */
  let selectedLink: string | null = null
  let selectedNode: string | null = null
  let focusLinks: string[] = []
  let focusNodes: string[] = []

  function bboxOf(m: MlMap): BBox {
    const b = m.getBounds()
    return {
      minLng: b.getWest(),
      minLat: b.getSouth(),
      maxLng: b.getEast(),
      maxLat: b.getNorth(),
    }
  }

  function mount() {
    const el = opts.container.value
    if (!el || map) return

    map = new maplibregl.Map({
      container: el,
      style: baseStyle(opts.dark.value),
      center: opts.center ?? [-1.6778, 48.1173],
      zoom: opts.zoom ?? 8,
      attributionControl: { compact: true },
      // Rotation adds nothing to reading a link graph and makes the labels worse.
      pitchWithRotate: false,
      dragRotate: false,
    })
    // Exposed for debugging from the console and for end-to-end screenshots.
    ;(window as unknown as { __meshqualMap?: MlMap }).__meshqualMap = map
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left')

    map.on('load', () => {
      if (!map) return
      map.addImage(CHEVRON, chevronImage(), { pixelRatio: 2, sdf: true })
      addDataLayers()
      ready = true
      applyView()
      applyFocus()
      if (pendingLinks) setLinks(pendingLinks)
      if (pendingNodes) setNodes(pendingNodes)
      opts.onMoveEnd(bboxOf(map))
    })

    map.on('moveend', () => {
      if (map) opts.onMoveEnd(bboxOf(map))
    })

    const hitAt = (point: maplibregl.Point) => {
      if (!map) return []
      const box: [maplibregl.PointLike, maplibregl.PointLike] = [
        [point.x - CLICK_TOLERANCE, point.y - CLICK_TOLERANCE],
        [point.x + CLICK_TOLERANCE, point.y + CLICK_TOLERANCE],
      ]
      return map.queryRenderedFeatures(box, {
        layers: [LAYER_ACTIVE, LAYER_LANES, LAYER_LANES_MISSING, LAYER_MEASURED, LAYER_TOPOLOGY],
      })
    }

    // Nodes sit on top of links and win a click that touches both.
    const nodeAt = (point: maplibregl.Point): string | null => {
      if (!map) return null
      const box: [maplibregl.PointLike, maplibregl.PointLike] = [
        [point.x - CLICK_TOLERANCE, point.y - CLICK_TOLERANCE],
        [point.x + CLICK_TOLERANCE, point.y + CLICK_TOLERANCE],
      ]
      const key = map.queryRenderedFeatures(box, { layers: [LAYER_NODES] })[0]?.properties?.['key']
      return typeof key === 'string' ? key : null
    }

    map.on('click', (e) => {
      const node = nodeAt(e.point)
      if (node) {
        opts.onSelectNode(node)
        return
      }
      const id = hitAt(e.point)[0]?.properties?.['linkId']
      if (typeof id === 'string') {
        opts.onSelectLink(id)
        return
      }
      opts.onSelectLink(null)
      opts.onSelectNode(null)
    })

    map.on('mousemove', (e) => {
      if (!map) return
      map.getCanvas().style.cursor = nodeAt(e.point) || hitAt(e.point).length > 0 ? 'pointer' : ''
    })
  }

  function addDataLayers() {
    if (!map) return
    for (const layer of dataLayers(opts.dark.value, opts.thresholds.value, opts.palette.value)) {
      if (!map.getLayer(layer.id)) map.addLayer(layer as never)
    }
  }

  function setLinks(fc: FeatureCollection<LinkProperties>) {
    pendingLinks = fc
    if (!map || !ready) return
    const src = map.getSource(LINKS_SOURCE)
    if (src && 'setData' in src) {
      // One setData call replaces the whole layer. This is why the API returns
      // GeoJSON: there is no transform step between fetch and render.
      ;(src as maplibregl.GeoJSONSource).setData(fc as never)
    }
    const threshold = opts.asymThreshold.value
    const lanes = map.getSource(LANES_SOURCE)
    if (lanes && 'setData' in lanes) {
      ;(lanes as maplibregl.GeoJSONSource).setData(buildLanes(fc, threshold) as never)
    }
    emphasizedIds = fc.features
      .filter((f) => isAsymmetric(f.properties, threshold))
      .map((f) => f.properties.linkId)
    // A refresh can bring in more of a selected node's links (after a zoom out).
    if (selectedNode) {
      computeFocus()
      applyFocus()
    }
    trackActive(fc)
  }

  /**
   * Records which links were heard in the last ACTIVE_MS. The expiry comes from
   * the server-computed `ageSec` and the local clock at fetch time, so a skewed
   * client clock cannot keep a link animated or cut it short.
   */
  function trackActive(fc: FeatureCollection<LinkProperties>) {
    const now = Date.now()
    const present = new Set<string>()
    for (const f of fc.features) {
      const p = f.properties
      present.add(p.linkId)
      const remaining = ACTIVE_MS - p.ageSec * 1000
      if (remaining <= 0 || f.geometry.type !== 'LineString') continue
      const coords = f.geometry.coordinates
      const snr =
        p.lastSnr ?? (p.lastForward ? p.snrMedianAB : p.snrMedianBA) ?? p.snrQuality ?? p.snrMedian
      active.set(p.linkId, {
        expiresAt: now + remaining,
        feature: {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: p.lastForward ? coords : [...coords].reverse() },
          properties: {
            linkId: p.linkId,
            laneId: laneId(p.linkId, p.lastForward),
            lanes: p.kind !== 'topology',
            emphasized: isAsymmetric(p, opts.asymThreshold.value),
            weight: p.weight,
            ...(snr !== undefined && { snrActive: snr }),
          },
        },
      })
    }
    // A link filtered out or scrolled off the map stops animating with it.
    for (const id of active.keys()) if (!present.has(id)) active.delete(id)
    syncActive()
  }

  /** Pushes the active set to the map and hides the static line under each one. */
  function syncActive() {
    if (!map || !ready) return
    const src = map.getSource(ACTIVE_SOURCE)
    if (src && 'setData' in src) {
      ;(src as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: [...active.values()].map((a) => a.feature),
      } as never)
    }
    applyFilters()
    if (active.size > 0 && raf === 0) raf = requestAnimationFrame(tick)
  }

  /**
   * Switches between the quality view (one line per link, coloured by the
   * weaker direction) and the asymmetry view (one lane per direction).
   */
  function applyView() {
    if (!map || !ready) return
    const m = map
    const asym = opts.mode.value === 'asymmetry'
    const only = asym && opts.asymOnly.value
    const show = (id: string, on: boolean) => m.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none')
    show(LAYER_MEASURED, !asym)
    show(LAYER_LANES, asym)
    show(LAYER_LANES_MISSING, asym)
    show(LAYER_LANE_ARROWS, asym)
    show(LAYER_TOPOLOGY, !only)
    m.setPaintProperty(
      LAYER_CASING,
      'line-width',
      asym ? laneAware(LINK_HAS_LANES, LANE_CASING_AT, 3) : widthExpr(3),
    )
    m.setPaintProperty(
      LAYER_SELECTED,
      'line-width',
      asym ? laneAware(LINK_HAS_LANES, LANE_SELECTED_AT, 2.5) : widthExpr(2.5),
    )
    m.setPaintProperty(
      LAYER_ACTIVE,
      'line-width',
      asym ? laneAware(ACTIVE_HAS_LANES, LANE_WIDTH_AT, 1) : widthExpr(1),
    )
    m.setPaintProperty(
      LAYER_ACTIVE,
      'line-offset',
      asym ? laneAware(ACTIVE_HAS_LANES, LANE_OFFSET_AT, 0, 0) : 0,
    )
    applyFilters()
  }

  /**
   * One place composes every filter: link kind, the lines hidden under an
   * animation, and the "asymmetric only" restriction.
   */
  function applyFilters() {
    if (!map || !ready) return
    const only = opts.mode.value === 'asymmetry' && opts.asymOnly.value
    const notIn = (prop: string, ids: string[]): ExpressionSpecification => [
      '!',
      ['in', ['get', prop], ['literal', ids]],
    ]
    const activeLinks = [...active.keys()]
    const activeLanes = [...active.values()].map((a) => a.feature.properties.laneId)
    const emph: ExpressionSpecification[] = only ? [EMPHASIZED] : []
    map.setFilter(LAYER_TOPOLOGY, ['all', TOPOLOGY_FILTER, notIn('linkId', activeLinks)])
    map.setFilter(LAYER_MEASURED, ['all', MEASURED_FILTER, notIn('linkId', activeLinks)])
    map.setFilter(LAYER_LANES, ['all', ['==', ['get', 'measured'], true], notIn('laneId', activeLanes), ...emph])
    map.setFilter(LAYER_LANES_MISSING, ['all', ['==', ['get', 'measured'], false], ...emph])
    map.setFilter(LAYER_LANE_ARROWS, only ? EMPHASIZED : null)
    map.setFilter(LAYER_ACTIVE, only ? EMPHASIZED : null)
    map.setFilter(LAYER_CASING, only ? ['in', ['get', 'linkId'], ['literal', emphasizedIds]] : null)
  }

  function tick(t: number) {
    raf = 0
    if (!map || !ready) return
    const now = Date.now()
    let expired = false
    for (const [id, a] of active) {
      if (a.expiresAt <= now) {
        active.delete(id)
        expired = true
      }
    }
    if (expired) syncActive()
    if (active.size === 0) return
    if (!reducedMotion && t - lastDashAt >= DASH_FRAME_MS) {
      dashFrame = (dashFrame + 1) % DASH_FRAMES.length
      lastDashAt = t
      map.setPaintProperty(LAYER_ACTIVE, 'line-dasharray', DASH_FRAMES[dashFrame])
    }
    if (raf === 0) raf = requestAnimationFrame(tick)
  }

  function setNodes(fc: FeatureCollection<NodeProperties>) {
    pendingNodes = fc
    if (!map || !ready) return
    const src = map.getSource(NODES_SOURCE)
    if (src && 'setData' in src) {
      ;(src as maplibregl.GeoJSONSource).setData(fc as never)
    }
  }

  function highlight(linkId: string | null) {
    selectedLink = linkId
    computeFocus()
    if (!map || !map.getLayer(LAYER_SELECTED)) return
    map.setFilter(LAYER_SELECTED, ['==', ['get', 'linkId'], linkId ?? '__none__'])
    applyFocus()
  }

  function highlightNode(key: string | null) {
    selectedNode = key
    computeFocus()
    if (!map || !map.getLayer(LAYER_NODE_SELECTED)) return
    map.setFilter(LAYER_NODE_SELECTED, ['==', ['get', 'key'], key ?? '__none__'])
    applyFocus()
  }

  /**
   * What stays opaque: a selected link and its two ends, or a selected node with
   * every live link it has and the neighbours at their other end.
   */
  function computeFocus() {
    focusLinks = []
    focusNodes = []
    if (selectedLink) {
      const p = findLink(selectedLink)?.properties
      focusLinks = [selectedLink]
      focusNodes = p ? [p.aKey, p.bKey] : []
    } else if (selectedNode) {
      const key = selectedNode
      focusNodes = [key]
      for (const f of pendingLinks?.features ?? []) {
        const { aKey, bKey, linkId } = f.properties
        if (aKey !== key && bKey !== key) continue
        focusLinks.push(linkId)
        focusNodes.push(aKey === key ? bKey : aKey)
      }
    }
  }

  function findLink(linkId: string) {
    return pendingLinks?.features.find((f) => f.properties.linkId === linkId)
  }

  /** Fades everything outside the focus (see computeFocus); restores it all without one. */
  function applyFocus() {
    if (!map || !ready) return
    const on = selectedLink !== null || selectedNode !== null
    const inLinks: ExpressionSpecification = ['in', ['get', 'linkId'], ['literal', focusLinks]]
    for (const { layer, prop, base } of LINK_OPACITY) {
      map.setPaintProperty(layer, prop, on ? ['case', inLinks, 1, FOCUS_DIM] : base)
    }
    const inNodes: ExpressionSpecification = ['in', ['get', 'key'], ['literal', focusNodes]]
    const nodeOpacity = on ? ['case', inNodes, 1, NODE_FOCUS_DIM] : 1
    map.setPaintProperty(LAYER_NODES, 'circle-opacity', nodeOpacity)
    map.setPaintProperty(LAYER_NODES, 'circle-stroke-opacity', nodeOpacity)
    // Only focused nodes keep a label: other labels would compete for the space.
    map.setFilter(LAYER_NODE_LABELS, on ? inNodes : null)
  }

  /**
   * Frames the link so it fills the part of the map left visible by the
   * overlays, given as padding in pixels.
   */
  function focusLink(linkId: string, padding: Padding) {
    const f = findLink(linkId)
    if (!f || f.geometry.type !== 'LineString') return
    focusPoints(f.geometry.coordinates as [number, number][], padding)
  }

  /** Frames a set of [lng, lat] points the same way (a node and its neighbours). */
  function focusPoints(points: [number, number][], padding: Padding) {
    if (!map || points.length === 0) return
    const lngs = points.map((p) => p[0])
    const lats = points.map((p) => p[1])
    // fitBounds refuses padding wider than the map; shrink it proportionally.
    const { clientWidth: w, clientHeight: h } = map.getContainer()
    const sx = Math.min(1, (w - 80) / (padding.left + padding.right))
    const sy = Math.min(1, (h - 80) / (padding.top + padding.bottom))
    map.fitBounds(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      {
        padding: {
          top: padding.top * sy,
          bottom: padding.bottom * sy,
          left: padding.left * sx,
          right: padding.right * sx,
        },
        maxZoom: 15,
        duration: 600,
      },
    )
  }

  /** Re-theme in place: dark mode gets its own steps, not an automatic flip. */
  function retheme() {
    if (!map || !ready) return
    for (const id of [
      LAYER_NODE_LABELS,
      LAYER_NODE_SELECTED,
      LAYER_NODES,
      LAYER_SELECTED,
      LAYER_ACTIVE,
      LAYER_LANE_ARROWS,
      LAYER_LANES,
      LAYER_LANES_MISSING,
      LAYER_MEASURED,
      LAYER_TOPOLOGY,
      LAYER_CASING,
    ]) {
      if (map.getLayer(id)) map.removeLayer(id)
    }
    const dark = opts.dark.value
    map.setPaintProperty('basemap', 'raster-opacity', dark ? 0.45 : 0.75)
    map.setPaintProperty('basemap', 'raster-brightness-max', dark ? 0.55 : 1)
    addDataLayers()
    applyView()
    applyFocus()
    syncActive()
  }

  function fitTo(bbox: BBox) {
    map?.fitBounds(
      [
        [bbox.minLng, bbox.minLat],
        [bbox.maxLng, bbox.maxLat],
      ],
      { padding: 48, duration: 400 },
    )
  }

  onScopeDispose(() => {
    if (raf !== 0) cancelAnimationFrame(raf)
    map?.remove()
    map = null
    ready = false
  })

  return {
    mount,
    setLinks,
    setNodes,
    highlight,
    highlightNode,
    retheme,
    fitTo,
    applyView,
    focusLink,
    focusPoints,
  }
}
