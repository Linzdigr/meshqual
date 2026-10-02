// End-to-end smoke check: loads the app against a running backend, clicks the
// busiest measured link, and screenshots the result. Fails loudly on any console
// error that is not a blocked map tile.
//
//   node e2e/screenshot.mjs out.png [light|dark] [http://127.0.0.1:5173]
//
import { chromium } from 'playwright'

const out = process.argv[2]
const theme = process.argv[3] ?? 'light'
const base = process.argv[4] ?? 'http://127.0.0.1:5173'

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
)
const page = await browser.newPage({ viewport: { width: 1440, height: 880 }, deviceScaleFactor: 2 })

const errors = []
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => {
  const t = m.text()
  if (m.type() !== 'error') return
  if (t.includes('tile.openstreetmap') || t.includes('ERR_TUNNEL') || t.includes('AJAXError')) return
  errors.push(t)
})

await page.addInitScript((t) => {
  try {
    localStorage.setItem('meshqual.theme', t)
  } catch {}
}, theme)

await page.goto(base, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(4500)

const target = await page.evaluate(async () => {
  const res = await fetch('/api/links')
  const fc = await res.json()
  const best = fc.features
    .filter((f) => f.properties.kind !== 'topology' && f.properties.snrMedian !== undefined)
    .sort((a, b) => b.properties.samples - a.properties.samples)[0]
  return best ? { id: best.properties.linkId, coords: best.geometry.coordinates } : null
})

if (target) {
  const box = await page.locator('.maplibregl-canvas').boundingBox()
  const pt = await page.evaluate((c) => {
    const m = window.__meshqualMap
    if (!m) return null
    const mid = [(c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2]
    const p = m.project(mid)
    return { x: p.x, y: p.y }
  }, target.coords)
  if (box && pt) await page.mouse.click(box.x + pt.x, box.y + pt.y)
}

await page.waitForTimeout(2500)
await page.screenshot({ path: out })

const panelOpen = await page.locator('.panel').count()
const frameRows = await page.locator('.frames tbody tr').count()
console.log(JSON.stringify({ target: target?.id?.slice(0, 18), panelOpen, frameRows, errors }, null, 2))
await browser.close()

if (errors.length > 0) {
  console.error(`${errors.length} console error(s)`)
  process.exit(1)
}
if (panelOpen !== 1 || frameRows === 0) {
  console.error('the detail panel did not open with frames')
  process.exit(1)
}
