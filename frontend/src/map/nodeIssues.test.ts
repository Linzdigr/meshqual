import { describe, expect, it } from 'vitest'
import { issueFilter, nodeIssues } from './nodeIssues'

describe('nodeIssues', () => {
  it('flags 1-byte hashes on any node', () => {
    expect(nodeIssues({ nodeType: 'companion', pathHashSize: 1 })).toEqual(['hash1'])
    expect(nodeIssues({ nodeType: 'repeater', pathHashSize: 2 })).toEqual([])
  })

  it('flags a missing default region on repeaters and room servers only', () => {
    expect(nodeIssues({ nodeType: 'repeater', regionScope: 'none' })).toEqual(['noRegion'])
    expect(nodeIssues({ nodeType: 'room', regionScope: 'none', pathHashSize: 1 })).toEqual(['hash1', 'noRegion'])
    expect(nodeIssues({ nodeType: 'companion', regionScope: 'none' })).toEqual([])
    expect(nodeIssues({ nodeType: 'repeater', regionScope: 'set' })).toEqual([])
    expect(nodeIssues({ nodeType: 'repeater' })).toEqual([])
  })
})

describe('issueFilter', () => {
  it('matches nothing when every issue is switched off', () => {
    expect(issueFilter([])).toEqual(['boolean', false])
  })

  it('ors the enabled issues', () => {
    const f = issueFilter(['hash1', 'noRegion'])
    expect(f[0]).toBe('any')
    expect(f).toHaveLength(3)
    expect(issueFilter(['hash1'])).toEqual(['any', ['==', ['get', 'pathHashSize'], 1]])
  })
})
