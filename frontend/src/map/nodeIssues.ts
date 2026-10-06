import type { ExpressionSpecification } from 'maplibre-gl'

/**
 * Configuration problems a node shows in its own adverts, flagged by a single
 * ⚠ on the map ("nœud à configurer"); the legend can switch each one off.
 *
 * - hash1: path hashes on 1 byte, 256 values only, so they collide.
 * - noRegion: a repeater or room server flooding without a default region;
 *   repeaters set to `region denyf *` drop such packets. Companions are left
 *   out: their scope is their user's choice.
 */
export type NodeIssue = 'hash1' | 'noRegion'

export const NODE_ISSUES: NodeIssue[] = ['hash1', 'noRegion']

interface IssueProps {
  nodeType?: string
  pathHashSize?: number
  regionScope?: string
}

const INFRA = ['repeater', 'room']

export function nodeIssues(p: IssueProps): NodeIssue[] {
  const out: NodeIssue[] = []
  if (p.pathHashSize === 1) out.push('hash1')
  if (p.regionScope === 'none' && INFRA.includes(p.nodeType ?? '')) out.push('noRegion')
  return out
}

/** The ⚠ layer filter: nodes with at least one of the enabled issues. */
export function issueFilter(enabled: readonly NodeIssue[]): ExpressionSpecification {
  const tests: ExpressionSpecification[] = []
  if (enabled.includes('hash1')) tests.push(['==', ['get', 'pathHashSize'], 1])
  if (enabled.includes('noRegion')) {
    tests.push(['all', ['==', ['get', 'regionScope'], 'none'], ['in', ['get', 'nodeType'], ['literal', INFRA]]])
  }
  return tests.length ? ['any', ...tests] : ['==', 1, 0]
}
