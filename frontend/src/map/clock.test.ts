import { describe, expect, it } from 'vitest'
import { clockOff, formatOffset } from './clock'

describe('formatOffset', () => {
  it('keeps the two largest units, with the sign', () => {
    expect(formatOffset(-(3 * 86_400 + 4 * 3_600 + 59))).toBe('−3 j 4 h')
    expect(formatOffset(12 * 60)).toBe('+12 min')
    expect(formatOffset(-40)).toBe('−40 s')
    expect(formatOffset(0)).toBe('+0 s')
    expect(formatOffset(-(2 * 365 * 86_400 + 5 * 86_400))).toBe('−2 ans 5 j')
  })
})

describe('clockOff', () => {
  it('flags offsets either way from the threshold', () => {
    expect(clockOff(-600, 600)).toBe(true)
    expect(clockOff(900, 600)).toBe(true)
    expect(clockOff(-30, 600)).toBe(false)
    expect(clockOff(undefined, 600)).toBe(false)
  })
})
