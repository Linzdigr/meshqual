const MIN = 60
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const MONTH = 30 * DAY
const YEAR = 365 * DAY

/**
 * A duration in seconds as a short French reading: "42 s", "12 min",
 * "1 h 12 min", "3 j 4 h", "2 mois", "1 an". Two units at most, and the second
 * only below a day, where it still matters.
 */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  if (s < MIN) return `${s} s`
  if (s < HOUR) return `${Math.floor(s / MIN)} min`
  if (s < DAY) {
    const h = Math.floor(s / HOUR)
    const m = Math.floor((s % HOUR) / MIN)
    return m > 0 ? `${h} h ${m} min` : `${h} h`
  }
  if (s < MONTH) {
    const d = Math.floor(s / DAY)
    const h = Math.floor((s % DAY) / HOUR)
    return h > 0 ? `${d} j ${h} h` : `${d} j`
  }
  if (s < YEAR) return `${Math.floor(s / MONTH)} mois`
  const y = Math.floor(s / YEAR)
  return `${y} an${y > 1 ? 's' : ''}`
}

/** Seconds elapsed since an ISO timestamp, never negative. */
export function secondsSince(iso: string, now = Date.now()): number {
  return Math.max(0, (now - new Date(iso).getTime()) / 1000)
}
