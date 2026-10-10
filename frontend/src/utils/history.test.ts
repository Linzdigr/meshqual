import { describe, expect, it } from 'vitest'
import { historySpan } from './history'

const DAY = 86_400

describe('historySpan', () => {
  it('covers the whole retention in 4-hour buckets', () => {
    expect(historySpan(14 * DAY)).toEqual({ window: `${14 * DAY}s`, bucket: '4h', label: '14 j' })
  })

  it('never narrows below a week', () => {
    expect(historySpan(DAY)).toEqual({ window: `${7 * DAY}s`, bucket: '4h', label: '7 j' })
  })
})
