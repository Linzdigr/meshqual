import { describe, expect, it } from 'vitest'
import { formatDuration, secondsSince } from './duration'

describe('formatDuration', () => {
  it('picks the largest readable unit', () => {
    expect(formatDuration(0)).toBe('0 s')
    expect(formatDuration(42)).toBe('42 s')
    expect(formatDuration(60)).toBe('1 min')
    expect(formatDuration(59 * 60 + 59)).toBe('59 min')
    expect(formatDuration(3600)).toBe('1 h')
    expect(formatDuration(4303)).toBe('1 h 11 min')
    expect(formatDuration(86400)).toBe('1 j')
    expect(formatDuration(3 * 86400 + 4 * 3600 + 120)).toBe('3 j 4 h')
    expect(formatDuration(45 * 86400)).toBe('1 mois')
    expect(formatDuration(364 * 86400)).toBe('12 mois')
    expect(formatDuration(365 * 86400)).toBe('1 an')
    expect(formatDuration(3 * 365 * 86400)).toBe('3 ans')
  })

  it('never goes negative', () => {
    expect(formatDuration(-5)).toBe('0 s')
    expect(secondsSince('2030-01-01T00:00:00Z', Date.parse('2026-01-01T00:00:00Z'))).toBe(0)
  })
})
