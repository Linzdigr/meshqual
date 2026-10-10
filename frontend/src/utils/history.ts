/**
 * The span of a link's SNR history chart: the whole measurement retention
 * (14 days by default), never less than a week, in 4-hour buckets. Between
 * repeaters, signal only comes from occasional traces, so a shorter span
 * would leave most of those links with nothing to draw.
 */
export const HISTORY_MIN_DAYS = 7

export interface HistorySpan {
  /** Go duration strings, as the history endpoint takes them. */
  window: string
  bucket: string
  /** For the chart caption: "14 j". */
  label: string
}

export function historySpan(retentionSec: number): HistorySpan {
  const sec = Math.max(retentionSec, HISTORY_MIN_DAYS * 86_400)
  return { window: `${sec}s`, bucket: '4h', label: `${Math.round(sec / 86_400)} j` }
}
