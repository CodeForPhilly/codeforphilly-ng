# MapLibre GL JS Patterns

Patterns for building interactive maps with MapLibre GL JS in React applications.

## Setup

```bash
bun add maplibre-gl
```

```typescript
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
```

**v6 removed the default export** (see the [v5→v6 migration guide](https://github.com/maplibre/maplibre-gl-js/blob/main/docs/guides/v5-to-v6-migration-guide.md)); use the namespace import above (keeps `maplibregl.*` examples working) or named imports (`import { Map, Popup, setWorkerUrl } from 'maplibre-gl'`).

### Worker URL Under Bundlers

MapLibre tiles GeoJSON (and more) in a module worker resolved relative to the library's own `import.meta.url`. Any step that relocates the library — Vite dep optimization in dev, Rollup/production bundling always — breaks that resolution, and the failure is **silent** (see [Silent Worker-Pipeline Failures](#silent-worker-pipeline-failures)). Pin it explicitly at module scope:

```typescript
import { setWorkerUrl } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'

setWorkerUrl(workerUrl)
```

**`?worker&url`, not plain `?url` — this is load-bearing.** Plain `?url` emits the worker file verbatim *without following its imports*, so the built asset still says `import "./maplibre-gl-shared.mjs"` next to no such file: dead on arrival in any production build, with the silent signature below. It goes unnoticed in dev, where the dev server serves `node_modules` paths directly. `?worker&url` bundles the worker entry whole. (Verified against a real Vite build: plain `?url` left a dangling shared-chunk import; `?worker&url` emitted a self-contained chunk. MapLibre's own install docs prescribe the same.)

Under Vite, also consider `optimizeDeps: { exclude: ['maplibre-gl'] }` so the dev server serves the library's published files byte-for-byte — a transformed copy behaves subtly differently from the artifact you'll ship, which makes works-in-dev/fails-in-prod comparisons lie.

### Keyless Styles

The examples below use MapTiler, which needs an API key. Keyless options:

- **Data-only canvas** (your GeoJSON is the whole map): an inline empty style — `style: { version: 8, sources: {}, layers: [] }` — full GL interaction, no tiles, no key, no network dependency.
- **Real basemap, no key**: [OpenFreeMap](https://openfreemap.org) style URLs (`https://tiles.openfreemap.org/styles/liberty`, `bright`, `positron`) — MapLibre-native vector styles, no usage caps.

## Map Initialization

### Single Instance Pattern (React)

Create the map once on mount, never recreate. Use refs for stable instance access:

```typescript
const mapContainer = useRef<HTMLDivElement>(null)
const map = useRef<maplibregl.Map | null>(null)
const [mapLoaded, setMapLoaded] = useState(false)

useEffect(() => {
  if (!mapContainer.current || map.current) return

  map.current = new maplibregl.Map({
    container: mapContainer.current,
    style: 'https://api.maptiler.com/maps/streets/style.json?key=YOUR_KEY',
    center: [-75.1652, 39.9526],
    zoom: 12,
  })

  map.current.addControl(new maplibregl.NavigationControl())

  map.current.on('load', () => {
    setMapLoaded(true)
  })

  return () => {
    map.current?.remove()
    map.current = null
  }
}, []) // Empty deps - initialize once
```

**React StrictMode:** dev double-mounts effects, so the pattern above builds and tears down a full map (GL context + worker pool) once per page view — and `remove()` does not return those resources synchronously. Defer creation one macrotask so the throwaway mount cancels a timer instead of creating a map:

```typescript
useEffect(() => {
  const timer = window.setTimeout(() => {
    if (!mapContainer.current || map.current) return
    map.current = initializeMap(mapContainer.current)
  }, 0)
  return () => {
    window.clearTimeout(timer)
    map.current?.remove()
    map.current = null
  }
}, [])
```

### Centralized Config

Extract constants and initialization to a config file:

```typescript
// mapConfig.ts
export const DEFAULT_CENTER: [number, number] = [-75.1652, 39.9526]
export const DEFAULT_ZOOM = 12
export const ZOOM_THRESHOLD = 13 // For scale-dependent rendering

export function initializeMap(container: HTMLElement) {
  const map = new maplibregl.Map({
    container,
    style: 'https://api.maptiler.com/maps/openstreetmap/style.json?key=YOUR_KEY',
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM
  })
  map.addControl(new maplibregl.NavigationControl())
  return map
}
```

## Layer Management

### Layer Ordering

Add layers in visual order (bottom to top): base fill, hover, selection, lines, labels.

```typescript
// Add source first
map.addSource('regions', {
  type: 'geojson',
  data: geojsonData
})

// Base fill layer
map.addLayer({
  id: 'regions-fill',
  type: 'fill',
  source: 'regions',
  paint: {
    'fill-color': '#627BC1',
    'fill-opacity': 0.8
  }
})

// Hover layer (filter-based for efficiency)
map.addLayer({
  id: 'regions-hover',
  type: 'line',
  source: 'regions',
  paint: {
    'line-color': '#000000',
    'line-width': 2
  },
  filter: ['==', ['get', 'id'], ''] // Empty = hidden
})

// Selection layer
map.addLayer({
  id: 'regions-selection',
  type: 'fill',
  source: 'regions',
  paint: {
    'fill-color': '#ff474c',
    'fill-opacity': 0.6
  },
  filter: ['==', ['get', 'id'], '']
})

// Labels last (always on top)
map.addLayer({
  id: 'regions-labels',
  type: 'symbol',
  source: 'regions',
  minzoom: 13, // Only show at higher zoom
  layout: {
    'text-field': ['get', 'name'],
    'text-size': 14,
    'text-allow-overlap': true
  },
  paint: {
    'text-color': '#ffffff',
    'text-halo-color': '#000000',
    'text-halo-width': 1
  }
})
```

### Safe Layer Removal

Always check existence before removing:

```typescript
function removeLayerSafely(map: maplibregl.Map, layerId: string, sourceId: string) {
  if (map.getLayer(layerId)) {
    map.removeLayer(layerId)
  }
  if (map.getSource(sourceId)) {
    map.removeSource(sourceId)
  }
}
```

### Style Load Guard

Wait for style to load before manipulating layers:

```typescript
if (!map.isStyleLoaded()) {
  map.once('style.load', () => {
    addLayers(map)
  })
  return
}
addLayers(map)
```

## Source Management

### Dynamic GeoJSON Updates

Use `setData()` to update source data:

```typescript
async function updateSourceWithCounts(map: maplibregl.Map, stats: Record<string, number>) {
  const source = map.getSource('regions') as maplibregl.GeoJSONSource
  if (!source) return

  // Get current data and update properties. Prefer keeping source data in
  // application state and re-deriving; when reading back from the map,
  // v6's getData() (async) returns the actual GeoJSON — serialize().data
  // can be the original URL string for URL-created sources, and `_data`
  // is a private field.
  const currentData = (await source.getData()) as GeoJSON.FeatureCollection
  const updatedFeatures = currentData.features.map(feature => ({
    ...feature,
    properties: {
      ...feature.properties,
      count: Number(stats[feature.properties?.id] ?? 0)
    }
  }))

  source.setData({
    type: 'FeatureCollection',
    features: updatedFeatures
  })
}
```

## Event Handling

### Click and Hover with Refs

Store callbacks in refs to avoid stale closures:

```typescript
const onFeatureClickRef = useRef(onFeatureClick)
useEffect(() => {
  onFeatureClickRef.current = onFeatureClick
}, [onFeatureClick])

// In layer setup effect:
const handleClick = (e: maplibregl.MapLayerMouseEvent) => {
  if (!e.features?.length) return
  const feature = e.features[0]
  onFeatureClickRef.current?.(feature.properties?.id, feature)
}

const handleMouseMove = (e: maplibregl.MapLayerMouseEvent) => {
  map.getCanvas().style.cursor = 'pointer'
  if (e.features?.length) {
    const id = e.features[0].properties?.id
    map.setFilter('regions-hover', ['==', ['get', 'id'], id])
  }
}

const handleMouseLeave = () => {
  map.getCanvas().style.cursor = ''
  map.setFilter('regions-hover', ['==', ['get', 'id'], ''])
}

map.on('click', 'regions-fill', handleClick)
map.on('mousemove', 'regions-fill', handleMouseMove)
map.on('mouseleave', 'regions-fill', handleMouseLeave)

// Cleanup
return () => {
  map.off('click', 'regions-fill', handleClick)
  map.off('mousemove', 'regions-fill', handleMouseMove)
  map.off('mouseleave', 'regions-fill', handleMouseLeave)
}
```

### Background Click for Deselection

```typescript
const handleMapBackgroundClick = (e: maplibregl.MapMouseEvent) => {
  const features = map.queryRenderedFeatures(e.point, {
    layers: ['regions-fill']
  })
  if (features.length === 0) {
    onFeatureClickRef.current?.(null, null) // Clear selection
  }
}

map.on('click', handleMapBackgroundClick)
```

## Popup Management

### Shared Popup Pattern

For multi-map scenarios, share a popup ref to ensure only one popup is visible:

```typescript
interface Props {
  sharedPopupRef?: React.MutableRefObject<maplibregl.Popup | null>
}

function MapComponent({ sharedPopupRef }: Props) {
  const localPopupRef = useRef<maplibregl.Popup | null>(null)
  const popupRef = sharedPopupRef || localPopupRef

  const createPopup = useCallback((
    map: maplibregl.Map,
    lngLat: [number, number],
    feature: GeoJSON.Feature
  ) => {
    // CRITICAL: Clear ref before removing old popup
    // This prevents old popup's close handler from clearing selection
    const oldPopup = popupRef.current
    popupRef.current = null
    oldPopup?.remove()

    const popup = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: false, // Handle manually
    })
      .setLngLat(lngLat)
      .setHTML(buildPopupHTML(feature))
      .addTo(map)

    popupRef.current = popup

    popup.on('close', () => {
      if (popupRef.current === popup) {
        onFeatureClickRef.current?.(null, null)
        popupRef.current = null
      }
    })
  }, [])
}
```

### Popup HTML Builder

```typescript
const buildPopupHTML = (feature: GeoJSON.Feature): string => {
  const props = feature.properties
  return `
    <div class="p-2">
      <h3 class="font-semibold">${props?.name || 'Unknown'}</h3>
      <p class="text-sm">Value: ${props?.value?.toFixed(1) ?? 'N/A'}</p>
    </div>
  `
}
```

## Custom Markers

### DOM Element Marker

```typescript
function createPulsingMarker() {
  const el = document.createElement('div')
  el.style.cssText = `
    width: 50px; height: 50px;
    display: flex; align-items: center; justify-content: center;
  `

  const dot = document.createElement('div')
  dot.style.cssText = `
    width: 12px; height: 12px;
    background-color: #3388ff;
    border-radius: 50%;
  `
  el.appendChild(dot)

  // Add animated rings
  for (let i = 0; i < 3; i++) {
    const ring = document.createElement('div')
    ring.style.cssText = `
      position: absolute;
      border: 2px solid #3388ff;
      border-radius: 50%;
      animation: pulse${i + 1} 2s infinite;
    `
    el.appendChild(ring)
  }

  return el
}

const marker = new maplibregl.Marker({
  element: createPulsingMarker(),
  anchor: 'center'
})
  .setLngLat([lng, lat])
  .addTo(map)
```

### SDF Icons for Dynamic Coloring

Generate SDF images for icons that can be dynamically colored:

```bash
npx image-sdf icon.png --spread 10 --downscale 4 --color white > icon.sdf.png
```

```typescript
// Load SDF image
const image = await map.loadImage('/icon.sdf.png')
map.addImage('my-icon', image.data, { sdf: true })

// Use in layer with dynamic color
map.addLayer({
  id: 'markers',
  type: 'symbol',
  source: 'points',
  layout: {
    'icon-image': 'my-icon',
    'icon-size': 0.5,
  },
  paint: {
    'icon-color': ['get', 'color'], // Color from feature property
  }
})
```

## Data-Driven Styling

### Threshold-Based Colors

```typescript
const OTP_THRESHOLDS = { good: 83, fair: 70 }
const OTP_COLORS = { good: '#10b981', fair: '#f59e0b', poor: '#ef4444' }

const colorExpression: maplibregl.ExpressionSpecification = [
  'case',
  ['>=', ['get', 'pct_on_time'], OTP_THRESHOLDS.good], OTP_COLORS.good,
  ['>=', ['get', 'pct_on_time'], OTP_THRESHOLDS.fair], OTP_COLORS.fair,
  OTP_COLORS.poor,
]

map.addLayer({
  id: 'segments',
  type: 'line',
  source: 'data',
  paint: {
    'line-color': colorExpression,
    'line-width': 4,
  }
})
```

### Logarithmic Color Scale

For skewed data distributions:

```typescript
function getLogColorScale(minCount: number, maxCount: number) {
  const colors = ['#e5f5e0', '#c7e9c0', '#a1d99b', '#74c476', '#41ab5d', '#238b45', '#006d2c']
  const stops: [number, string][] = [[0, '#f5f5f5']] // Zero = gray

  if (minCount === maxCount) {
    stops.push([maxCount, colors[colors.length - 1]])
    return stops
  }

  const logMin = Math.log(Math.max(0.1, minCount))
  const logMax = Math.log(maxCount)
  const step = (logMax - logMin) / (colors.length - 1)

  colors.forEach((color, i) => {
    const value = Math.round(Math.exp(logMin + step * i) * 100) / 100
    stops.push([value, color])
  })

  return stops
}

// Apply to layer
map.setPaintProperty('regions-fill', 'fill-color', [
  'case',
  ['==', ['to-number', ['get', 'count']], 0], '#f5f5f5',
  ['interpolate', ['linear'], ['to-number', ['get', 'count']], ...colorStops.flat()]
])
```

### Null/Zero Value Handling

```typescript
const fillColorExpression = [
  'case',
  ['any',
    ['==', ['typeof', ['get', 'count']], 'null'],
    ['==', ['to-number', ['get', 'count']], 0]
  ],
  '#f5f5f5', // Gray for null/zero
  colorExpression
]
```

## Selection and Dimming

### Dim Non-Selected Features

```typescript
useEffect(() => {
  if (!map || !mapLoaded) return

  const opacityProp = isPointLayer ? 'circle-opacity' : 'line-opacity'

  if (selectedFeatureKey) {
    map.setPaintProperty(LAYER_ID, opacityProp, [
      'case',
      ['==', ['get', 'id'], selectedFeatureKey],
      0.8,  // Selected keeps full opacity
      0.2   // Non-selected dimmed
    ])
  } else {
    map.setPaintProperty(LAYER_ID, opacityProp, 0.8)
  }
}, [selectedFeatureKey, mapLoaded])
```

## Performance Patterns

### Debounce Frequent Operations

```typescript
function debounce<T extends (...args: any[]) => void>(fn: T, delay = 300) {
  let timeoutId: ReturnType<typeof setTimeout>
  return function (this: any, ...args: Parameters<T>) {
    clearTimeout(timeoutId)
    timeoutId = setTimeout(() => fn.apply(this, args), delay)
  }
}

// Usage: debounce fitBounds calls
const debouncedFitBounds = debounce((bounds: maplibregl.LngLatBounds) => {
  map.fitBounds(bounds, { padding: 50 })
}, 300)
```

### Query Features by Coordinates

```typescript
function findFeatureAtCoordinates(map: maplibregl.Map, lngLat: maplibregl.LngLat) {
  const features = map.queryRenderedFeatures(
    map.project([lngLat.lng, lngLat.lat]),
    { layers: ['regions-fill'] }
  )
  return features[0] ?? null
}
```

## Silent Worker-Pipeline Failures

When MapLibre's worker pipeline breaks, the signature is **silence**: every GeoJSON source reports loading forever, `queryRenderedFeatures()` returns nothing, and no error surfaces on the map, the console, or the worker. The map object looks healthy; `load` even fires (an empty style needs no worker).

**The diagnostic split** — main-thread truth vs worker-side truth:

```typescript
const src = map.getSource('lines') as maplibregl.GeoJSONSource
await src.getData()         // what the main thread holds (your setData landed)
src.loaded()                // whether the worker round-trip ever completed
map.queryRenderedFeatures() // what actually tiled and drew
```

Data present on the main thread while `loaded()` stays false *for good* is strong evidence the worker round-trip never completes — rule out the mundane first (very large or malformed GeoJSON, a request still legitimately in flight), then suspect the pipeline. Observed causes, all producing this identical signature:

| Cause | Fix |
|-------|-----|
| Bundler relocated the worker URL (Vite dep optimization, any production bundle) | `setWorkerUrl` + `?worker&url` import — see [Worker URL Under Bundlers](#worker-url-under-bundlers) |
| A fetch-intercepting service worker (e.g. MSW) reconstructs worker-script and module-import responses; Firefox's worker pipeline rejected them while Chromium tolerated them (observed: maplibre-gl 6.2, msw 2.15, Firefox 153 vs Chromium 150; reproduced and fix-verified — treat as a field note, not a spec guarantee) | In the SW's fetch handler, return without `respondWith` for requests with a non-empty `destination` (`script`, `worker`, `style`, `image`, …) — API mocking only ever concerns destination-`''` fetch/XHR requests |
| Two copies of the library on one page (e.g. a bundled copy in the app and a raw copy in a scratch page), each with its own worker configuration | Verify both sides of any works-here/fails-there comparison run identical bytes before trusting it; keep one import path |

## WebGL Capability, Loss, and Test Environments

- **MapLibre v6 requires WebGL2** (v5 and earlier defaulted to `webgl2withfallback`, trying WebGL1 when WebGL2 was missing; v6.x ships no fallback — verified against 6.2.0). On v6, probe for exactly `webgl2`; a WebGL1-only browser passes a loose `webgl2 ?? webgl` probe and receives a map whose context dies on arrival.
- **Probe once, and don't explicitly release the probe context.** `WEBGL_lose_context.loseContext()` logs "WebGL context was lost" to the console — indistinguishable from a real failure to anyone watching. One idle context until GC is the cheaper cost.
- **The v6 Map constructor survives GL-less environments** (happy-dom/jsdom test runners, some remote desktops and hardened browsers) **and fails at teardown instead** — `painter.destroy` throws from `remove()` on a half-initialized map (observed on 6.2.0 under happy-dom). Probe before constructing so such environments take a fallback path; the try/catch around `remove()` is a last-resort guard for contexts lost mid-session, not the primary strategy.
- **Handle `webglcontextlost`:** MapLibre attempts restoration itself; give it a beat, then degrade to a non-GL fallback rather than leaving a dead canvas that looks like a bug:

```typescript
map.on('webglcontextlost', () => {
  let restored = false
  map.once('webglcontextrestored', () => { restored = true })
  setTimeout(() => {
    if (!restored) {
      try { map.remove() } catch { /* painter already gone */ }
      showFallback()
    }
  }, 2000)
})
```

## Theme Colors from CSS Custom Properties

MapLibre's color parser predates `oklch()` and `color-mix()` — the forms modern Tailwind/shadcn tokens resolve to — and rejects them. Resolve design-system tokens to rgba through a canvas readback, and repaint when the theme flips:

```typescript
let scratch: CanvasRenderingContext2D | null | undefined
function resolveCssColor(value: string): string | null {
  if (scratch === undefined) {
    const c = document.createElement('canvas')
    c.width = c.height = 1
    scratch = c.getContext('2d', { willReadFrequently: true })
  }
  if (!scratch) return null
  // Sentinel first: assigning an INVALID color to fillStyle is silently
  // ignored (the previous value persists), so an unparseable token would
  // otherwise read back as whatever was painted last.
  scratch.fillStyle = '#010203'
  scratch.fillStyle = value
  if (scratch.fillStyle === '#010203' && value !== '#010203') return null
  scratch.clearRect(0, 0, 1, 1)
  scratch.fillRect(0, 0, 1, 1)
  const d = scratch.getImageData(0, 0, 1, 1).data
  return `rgba(${d[0]}, ${d[1]}, ${d[2]}, ${(d[3] ?? 255) / 255})`
}

// Token → paint, re-run on theme change (class-based dark mode shown).
// In React, run this inside an effect and disconnect on cleanup.
const repaint = () => {
  const styles = getComputedStyle(container)
  const color = resolveCssColor(styles.getPropertyValue('--accent').trim())
  if (color) map.setPaintProperty('lines', 'line-color', color)
}
repaint()
const observer = new MutationObserver(repaint)
observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
// …and when the map goes away:
observer.disconnect()
```

## Issues & Resolutions

| Issue | Cause | Solution |
|-------|-------|----------|
| **Popup conflicts between dual maps** | Each map creates its own popup | Use a shared `popupRef` passed as prop |
| **SDF image loading errors** | Using `createImageBitmap` instead of map API | Use `map.loadImage()` and access `.data` property |
| **Map fitting jank on resize** | `fitBounds` called too frequently | Debounce fitBounds calls |
| **Stale closure in callbacks** | React callback identity changes | Store callbacks in refs, update ref in separate effect |
| **Race conditions with style** | Manipulating layers before style loads | Guard with `isStyleLoaded()` + listen for `style.load` event |
| **Layer removal errors** | Removing non-existent layers | Always check `getLayer()` before `removeLayer()` |
| **Sources "loading" forever, zero errors anywhere** | Worker pipeline broken (relocated worker URL, SW interception, duplicate library copies) | See [Silent Worker-Pipeline Failures](#silent-worker-pipeline-failures) |
| **Blank map only in Firefox** | Service-worker-intercepted module-worker loads; Firefox is stricter than Chromium about reconstructed responses | Bypass non-empty-`destination` requests in the SW fetch handler |
| **Test runner crashes at unmount** | Constructor survives a GL-less environment; `remove()` throws (`painter.destroy`) | Probe WebGL2 before constructing; try/catch teardown |
| **Paint colors silently ignored** | `oklch()`/`color-mix()` from design tokens rejected by the GL color parser | Canvas-readback resolution — see [Theme Colors from CSS Custom Properties](#theme-colors-from-css-custom-properties) |
