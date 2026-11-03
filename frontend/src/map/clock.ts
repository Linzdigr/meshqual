import type { ExpressionSpecification } from 'maplibre-gl'

/**
 * Nodes whose clock is off, flagged by a clock beside the node. Adverts carry
 * the sender's time; relayd compares it with its own when an advert first
 * arrives (clockOffsetSec: node minus server). Peers drop an advert older
 * than the last one they kept from the same node, so a clock set back (a
 * reboot without RTC) leaves the node unheard until it catches up.
 */

/** Default threshold until /api/config answers (relayd clockOffsetMax). */
export const CLOCK_OFFSET_MAX_SEC = 600

export function clockOff(offsetSec: number | undefined | null, maxSec: number): boolean {
  return offsetSec != null && Math.abs(offsetSec) >= maxSec
}

/** The clock layer filter: nodes timed at least maxSec off. */
export function clockFilter(maxSec: number): ExpressionSpecification {
  return [
    'all',
    ['has', 'clockOffsetSec'],
    ['>=', ['abs', ['to-number', ['get', 'clockOffsetSec']]], maxSec],
  ] as ExpressionSpecification
}

/** "+3 j 4 h", "−12 min", "+40 s": the offset in its two largest units. */
export function formatOffset(sec: number): string {
  const sign = sec < 0 ? '−' : '+'
  let s = Math.abs(Math.round(sec))
  const units: [number, string][] = [
    [365 * 86_400, 'an'],
    [86_400, 'j'],
    [3_600, 'h'],
    [60, 'min'],
    [1, 's'],
  ]
  const parts: string[] = []
  for (const [size, label] of units) {
    if (s < size && !(size === 1 && parts.length === 0)) continue
    const n = Math.floor(s / size)
    s -= n * size
    parts.push(`${n} ${label}${label === 'an' && n > 1 ? 's' : ''}`)
    if (parts.length === 2) break
  }
  return sign + parts.join(' ')
}

/**
 * The clock as an image: a white dial ringed in dark, with dark hands, so it
 * stands out on both themes and reads apart from the yellow ⚠. Matches the
 * legend's ClockIcon.
 */
export function clockImage(): ImageData {
  const px = 28 // 14 CSS px at pixelRatio 2
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = px
  const ctx = canvas.getContext('2d')!
  ctx.beginPath()
  ctx.arc(14, 14, 11.5, 0, Math.PI * 2)
  ctx.fillStyle = '#ffffff'
  ctx.strokeStyle = '#1a1a19'
  ctx.lineWidth = 2.5
  ctx.fill()
  ctx.stroke()
  ctx.lineCap = 'round'
  ctx.lineWidth = 2.4
  ctx.beginPath()
  ctx.moveTo(14, 14)
  ctx.lineTo(14, 7)
  ctx.moveTo(14, 14)
  ctx.lineTo(19, 16.5)
  ctx.stroke()
  return ctx.getImageData(0, 0, px, px)
}
