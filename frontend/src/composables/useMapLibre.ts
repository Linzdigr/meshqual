import maplibregl, { type ExpressionSpecification, type Map as MlMap, type StyleSpecification } from 'maplibre-gl'
import { onScopeDispose, type Ref } from 'vue'
import type { BBox, FeatureCollection, LinkProperties, NodeProperties } from '@/api/types'
import {
  NO_DATA_DARK,
  NO_DATA_LIGHT,
  SURFACE_DARK,
  SURFACE_LIGHT,
  snrStepExpression,
} from '@/styles/scale'

export const LINKS_SOURCE = 'links'
export const NODES_SOURCE = 'nodes'

const LAYER_CASING = 'links-casing'
const LAYER_TOPOLOGY = 'links-topology'
const LAYER_MEASURED = 'links-measured'
const LAYER_SELECTED = 'links-selected'
const LAYER_NODES = 'nodes-circles'
const LAYER_NODE_LABELS = 'nodes-labels'

/**
 * Tile source. OpenStreetMap's own tiles carry a usage policy that forbids
 * heavy automated use, so point this at your own raster cache before putting the
 * map in front of a group.
 * https://tile.openstreetmap.org
 */
const TILE_URL =
  import.meta.env.VITE_TILE_URL ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'

const EMPTY_FC = { type: 'FeatureCollection', features: [] } as const

/**
 * Width is driven by traffic on a log scale (`weight` = log10(samples+1)): a
 * backbone link carries orders of magnitude more than a leaf, and a linear width
 * would collapse everything but the busiest pair into a hairline.
 *
 * MapLibre requires a `zoom` expression to be the input of a TOP-LEVEL step or
 * interpolate, so the extra width of the casing and the selection ring is baked
 * into the inner outputs rather than wrapped in an arithmetic expression.
 */
function widthExpr(extra = 0): ExpressionSpecification {
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    5,
    ['interpolate', ['linear'], ['get', 'weight'], 0, 0.8 + extra, 4, 2.5 + extra],
    11,
    ['interpolate', ['linear'], ['get', 'weight'], 0, 1.6 + extra, 4, 6 + extra],
  ]
}

const WIDTH = widthExpr()

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

function dataLayers(dark: boolean, thresholds: readonly number[]) {
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
        'line-opacity': 0.85,
        'line-width': widthExpr(3),
      },
    },
    // Topology links: the pair demonstrably hear each other, but no signal
    // measurement exists for them. Dashed and in ink, never a ramp step, so the
    // map cannot imply a quality it does not have.
    {
      id: LAYER_TOPOLOGY,
      type: 'line' as const,
      source: LINKS_SOURCE,
      filter: ['==', ['get', 'kind'], 'topology'] as ExpressionSpecification,
      layout: { 'line-cap': 'butt' as const, 'line-join': 'round' as const },
      paint: {
        'line-color': noData,
        'line-opacity': 0.45,
        'line-width': WIDTH,
        'line-dasharray': [2, 2] as unknown as ExpressionSpecification,
      },
    },
    // Measured and trace links: a real SNR, on the validated ordinal ramp.
    {
      id: LAYER_MEASURED,
      type: 'line' as const,
      source: LINKS_SOURCE,
      filter: ['!=', ['get', 'kind'], 'topology'] as ExpressionSpecification,
      layout: { 'line-cap': 'round' as const, 'line-join': 'round' as const },
      paint: {
        'line-color': snrStepExpression(thresholds, dark) as unknown as ExpressionSpecification,
        'line-width': WIDTH,
        'line-opacity': 0.95,
      },
    },
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

export interface UseMapOptions {
  container: Ref<HTMLElement | null>
  dark: Ref<boolean>
  thresholds: Ref<number[]>
  center?: [number, number]
  zoom?: number
  onMoveEnd: (bbox: BBox) => void
  onSelectLink: (linkId: string | null) => void
}

export function useMapLibre(opts: UseMapOptions) {
  let map: MlMap | null = null
  let ready = false
  let pendingLinks: FeatureCollection<LinkProperties> | null = null
  let pendingNodes: FeatureCollection<NodeProperties> | null = null

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
      addDataLayers()
      ready = true
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
      return map.queryRenderedFeatures(box, { layers: [LAYER_MEASURED, LAYER_TOPOLOGY] })
    }

    map.on('click', (e) => {
      const hits = hitAt(e.point)
      const id = hits[0]?.properties?.['linkId']
      opts.onSelectLink(typeof id === 'string' ? id : null)
    })

    map.on('mousemove', (e) => {
      if (!map) return
      map.getCanvas().style.cursor = hitAt(e.point).length > 0 ? 'pointer' : ''
    })
  }

  function addDataLayers() {
    if (!map) return
    for (const layer of dataLayers(opts.dark.value, opts.thresholds.value)) {
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
    if (!map || !map.getLayer(LAYER_SELECTED)) return
    map.setFilter(LAYER_SELECTED, ['==', ['get', 'linkId'], linkId ?? '__none__'])
  }

  /** Re-theme in place: dark mode gets its own steps, not an automatic flip. */
  function retheme() {
    if (!map || !ready) return
    for (const id of [
      LAYER_NODE_LABELS,
      LAYER_NODES,
      LAYER_SELECTED,
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
    map?.remove()
    map = null
    ready = false
  })

  return { mount, setLinks, setNodes, highlight, retheme, fitTo }
}
