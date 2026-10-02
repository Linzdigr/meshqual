import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SNR_THRESHOLDS,
  SNR_RAMP_DARK,
  SNR_RAMP_LIGHT,
  snrBucketIndex,
  snrBuckets,
  snrColor,
  snrStepExpression,
} from './scale'

const T = DEFAULT_SNR_THRESHOLDS

describe('snrBucketIndex', () => {
  it('maps dB values to the right bucket, boundaries included', () => {
    expect(snrBucketIndex(-30, T)).toBe(0)
    expect(snrBucketIndex(-12.01, T)).toBe(0)
    // A threshold is the inclusive lower bound of its own bucket.
    expect(snrBucketIndex(-12, T)).toBe(1)
    expect(snrBucketIndex(-5.01, T)).toBe(1)
    expect(snrBucketIndex(-5, T)).toBe(2)
    expect(snrBucketIndex(4.99, T)).toBe(2)
    expect(snrBucketIndex(5, T)).toBe(3)
    expect(snrBucketIndex(40, T)).toBe(3)
  })

  it('never returns an index outside the ramp', () => {
    for (const v of [-1e6, -20, 0, 12, 1e6, Number.MAX_SAFE_INTEGER]) {
      const i = snrBucketIndex(v, T)
      expect(i).toBeGreaterThanOrEqual(0)
      expect(i).toBeLessThan(SNR_RAMP_LIGHT.length)
    }
  })
})

describe('snrColor', () => {
  it('is monotone: a stronger link is never a darker step', () => {
    const order = [-20, -12, -5, 5, 20]
    const light = order.map((v) => SNR_RAMP_LIGHT.indexOf(snrColor(v, T, false) as never))
    expect(light).toEqual([0, 1, 2, 3, 3])
    const dark = order.map((v) => SNR_RAMP_DARK.indexOf(snrColor(v, T, true) as never))
    expect(dark).toEqual([0, 1, 2, 3, 3])
  })

  it('uses the mode-specific ramp, not an automatic flip', () => {
    expect(snrColor(0, T, false)).not.toBe(snrColor(0, T, true))
  })
})

describe('snrBuckets', () => {
  it('produces four contiguous buckets covering the whole line', () => {
    const b = snrBuckets(T)
    expect(b).toHaveLength(SNR_RAMP_LIGHT.length)
    expect(b[0]!.from).toBe(-Infinity)
    expect(b[b.length - 1]!.to).toBe(Infinity)
    for (let i = 1; i < b.length; i++) {
      expect(b[i]!.from).toBe(b[i - 1]!.to)
    }
  })

  it('labels every bucket with its dB range, so colour never carries the value alone', () => {
    for (const bucket of snrBuckets(T)) {
      expect(bucket.label).toMatch(/dB/)
      expect(bucket.note.length).toBeGreaterThan(0)
    }
  })
})

describe('snrStepExpression', () => {
  it('builds a MapLibre step expression with one colour per bucket', () => {
    const expr = snrStepExpression(T, false)
    expect(expr[0]).toBe('step')
    expect(expr[1]).toEqual(['get', 'snrMedian'])
    // step, input, base, then (threshold, colour) per edge
    expect(expr).toHaveLength(3 + T.length * 2)
    expect(expr[2]).toBe(SNR_RAMP_LIGHT[0])
    expect(expr[3]).toBe(T[0])
    expect(expr[4]).toBe(SNR_RAMP_LIGHT[1])
  })
})
