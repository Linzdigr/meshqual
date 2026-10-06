import { describe, expect, it } from 'vitest'
import { parseView } from './savedView'

describe('parseView', () => {
  it('reads a stored view', () => {
    expect(parseView('{"center":[-1.68,48.11],"zoom":11.5}')).toEqual({ center: [-1.68, 48.11], zoom: 11.5 })
  })

  it('rejects anything malformed or out of range', () => {
    for (const raw of [
      null,
      '',
      'not json',
      '{}',
      '{"center":[-1.68],"zoom":10}',
      '{"center":["a",48],"zoom":10}',
      '{"center":[-1.68,1988],"zoom":10}',
      '{"center":[-1.68,48.11],"zoom":40}',
    ]) {
      expect(parseView(raw)).toBeNull()
    }
  })
})
