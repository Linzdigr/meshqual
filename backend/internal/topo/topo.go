// Package topo analyses the observed link graph: which nodes hold the mesh
// together. It works on what was observed, so a node can look like a bridge
// only because the alternative paths were never heard.
package topo

import (
	"fmt"
	"sort"
)

// Graph is an undirected graph of node keys.
type Graph struct {
	adj map[string]map[string]struct{}
}

// New returns an empty graph.
func New() *Graph { return &Graph{adj: make(map[string]map[string]struct{})} }

// AddEdge records an undirected edge. Self-loops are ignored.
func (g *Graph) AddEdge(a, b string) {
	if a == "" || b == "" || a == b {
		return
	}
	g.link(a, b)
	g.link(b, a)
}

func (g *Graph) link(a, b string) {
	n := g.adj[a]
	if n == nil {
		n = make(map[string]struct{})
		g.adj[a] = n
	}
	n[b] = struct{}{}
}

// Level is how much the mesh depends on a node to stay connected.
type Level string

const (
	LevelLow      Level = "low"
	LevelMedium   Level = "medium"
	LevelHigh     Level = "high"
	LevelCritical Level = "critical"
)

// MinClusterSize is the smallest group that counts as a cluster when deciding
// whether a node is the only relay between two of them. A leaf hanging off a
// node is not a cluster.
const MinClusterSize = 3

// Metrics describes one node's place in the graph.
type Metrics struct {
	Degree int `json:"degree"`
	// Community is the group the node belongs to (label propagation).
	Community int `json:"community"`
	// Communities is the number of distinct groups among the node and its
	// neighbours: a node touching several groups sits between them.
	Communities int `json:"communities"`
	// Betweenness is the share of shortest paths between other nodes that go
	// through this one, normalised to 0..1 over the whole graph.
	Betweenness float64 `json:"betweenness"`
	// BetweennessRank is the share of nodes with a lower betweenness (0..1).
	BetweennessRank float64 `json:"betweennessRank"`
	// Articulation is true when removing the node disconnects its component.
	Articulation bool `json:"articulation"`
	// SplitSizes are the sizes of the parts its removal would leave, largest
	// first; empty when it is not an articulation point.
	SplitSizes []int    `json:"splitSizes"`
	Level      Level    `json:"level"`
	Reasons    []string `json:"reasons"`
}

// Analysis is the result over the whole graph.
type Analysis struct {
	Nodes       map[string]*Metrics
	NodeCount   int
	EdgeCount   int
	Communities int
}

// Analyze computes every metric. It is O(V·E) because of betweenness, which is
// fine for meshes of a few thousand nodes.
func Analyze(g *Graph) *Analysis {
	keys := make([]string, 0, len(g.adj))
	edges := 0
	for k, n := range g.adj {
		keys = append(keys, k)
		edges += len(n)
	}
	sort.Strings(keys)
	idx := make(map[string]int, len(keys))
	for i, k := range keys {
		idx[k] = i
	}
	// Sorted adjacency lists keep every algorithm below deterministic.
	adj := make([][]int, len(keys))
	for i, k := range keys {
		for nb := range g.adj[k] {
			adj[i] = append(adj[i], idx[nb])
		}
		sort.Ints(adj[i])
	}

	comm, nComm := communities(adj)
	bc := betweenness(adj)
	art, splits := articulation(adj)
	rank := ranks(bc)

	out := &Analysis{
		Nodes:     make(map[string]*Metrics, len(keys)),
		NodeCount: len(keys), EdgeCount: edges / 2, Communities: nComm,
	}
	for i, k := range keys {
		seen := map[int]struct{}{comm[i]: {}}
		for _, j := range adj[i] {
			seen[comm[j]] = struct{}{}
		}
		m := &Metrics{
			Degree: len(adj[i]), Community: comm[i], Communities: len(seen),
			Betweenness: bc[i], BetweennessRank: rank[i],
			Articulation: art[i], SplitSizes: splits[i],
		}
		if m.SplitSizes == nil {
			m.SplitSizes = []int{}
		}
		m.Level, m.Reasons = classify(m)
		out.Nodes[k] = m
	}
	return out
}

// classify turns the metrics into a level, with the reasons the UI shows.
func classify(m *Metrics) (Level, []string) {
	reasons := []string{}
	clusters := 0
	for _, s := range m.SplitSizes {
		if s >= MinClusterSize {
			clusters++
		}
	}
	if clusters >= 2 {
		reasons = append(reasons, fmt.Sprintf("seul relais entre %s", describeParts(m.SplitSizes)))
		return LevelCritical, reasons
	}

	level := LevelLow
	raise := func(l Level) {
		if order(l) > order(level) {
			level = l
		}
	}
	if m.Communities >= 3 {
		raise(LevelHigh)
		reasons = append(reasons, fmt.Sprintf("relie %d groupes de nœuds", m.Communities))
	} else if m.Communities == 2 {
		raise(LevelMedium)
		reasons = append(reasons, "relie 2 groupes de nœuds")
	}
	if m.Betweenness > 0 {
		switch {
		case m.BetweennessRank >= 0.95:
			raise(LevelHigh)
			reasons = append(reasons, "parmi les 5 % de nœuds par lesquels passent le plus de chemins")
		case m.BetweennessRank >= 0.80:
			raise(LevelMedium)
			reasons = append(reasons, "parmi les 20 % de nœuds par lesquels passent le plus de chemins")
		}
	}
	if m.Articulation {
		raise(LevelMedium)
		reasons = append(reasons, fmt.Sprintf("seul accès pour %s", describeSmall(m.SplitSizes)))
	}
	if len(reasons) == 0 {
		reasons = append(reasons, "d'autres chemins existent autour de ce nœud")
	}
	return level, reasons
}

func order(l Level) int {
	switch l {
	case LevelMedium:
		return 1
	case LevelHigh:
		return 2
	case LevelCritical:
		return 3
	}
	return 0
}

func describeParts(sizes []int) string {
	parts := make([]string, 0, len(sizes))
	for _, s := range sizes {
		if s >= MinClusterSize {
			parts = append(parts, fmt.Sprintf("%d", s))
		}
	}
	if len(parts) == 2 {
		return fmt.Sprintf("deux groupes de %s et %s nœuds", parts[0], parts[1])
	}
	return fmt.Sprintf("%d groupes (%v nœuds)", len(parts), parts)
}

// describeSmall names the part(s) that hang off the node, all but the largest.
func describeSmall(sizes []int) string {
	small := 0
	for _, s := range sizes[1:] {
		small += s
	}
	if small == 1 {
		return "1 nœud"
	}
	return fmt.Sprintf("%d nœuds", small)
}

// communities runs label propagation: each node repeatedly takes the most
// common label among its neighbours (ties to the smallest), in a fixed order so
// the result is reproducible. Labels are then renumbered 0..n-1.
func communities(adj [][]int) ([]int, int) {
	label := make([]int, len(adj))
	for i := range label {
		label[i] = i
	}
	for round := 0; round < 30; round++ {
		changed := false
		for i, nbs := range adj {
			if len(nbs) == 0 {
				continue
			}
			count := map[int]int{}
			for _, j := range nbs {
				count[label[j]]++
			}
			best, bestN := label[i], 0
			for l, n := range count {
				if n > bestN || (n == bestN && l < best) {
					best, bestN = l, n
				}
			}
			if best != label[i] {
				label[i], changed = best, true
			}
		}
		if !changed {
			break
		}
	}
	renum := map[int]int{}
	for i, l := range label {
		if _, ok := renum[l]; !ok {
			renum[l] = len(renum)
		}
		label[i] = renum[l]
	}
	return label, len(renum)
}

// betweenness is Brandes' algorithm for unweighted graphs, normalised by the
// number of pairs of other nodes so values are comparable across meshes.
func betweenness(adj [][]int) []float64 {
	n := len(adj)
	bc := make([]float64, n)
	sigma := make([]float64, n)
	dist := make([]int, n)
	delta := make([]float64, n)
	pred := make([][]int, n)
	stack := make([]int, 0, n)
	queue := make([]int, 0, n)
	for s := 0; s < n; s++ {
		stack, queue = stack[:0], queue[:0]
		for i := range sigma {
			sigma[i], dist[i], delta[i], pred[i] = 0, -1, 0, pred[i][:0]
		}
		sigma[s], dist[s] = 1, 0
		queue = append(queue, s)
		for h := 0; h < len(queue); h++ {
			v := queue[h]
			stack = append(stack, v)
			for _, w := range adj[v] {
				if dist[w] < 0 {
					dist[w] = dist[v] + 1
					queue = append(queue, w)
				}
				if dist[w] == dist[v]+1 {
					sigma[w] += sigma[v]
					pred[w] = append(pred[w], v)
				}
			}
		}
		for i := len(stack) - 1; i >= 0; i-- {
			w := stack[i]
			for _, v := range pred[w] {
				delta[v] += sigma[v] / sigma[w] * (1 + delta[w])
			}
			if w != s {
				bc[w] += delta[w]
			}
		}
	}
	// Each pair was counted from both ends.
	if pairs := float64(n-1) * float64(n-2); pairs > 0 {
		for i := range bc {
			bc[i] /= pairs
		}
	}
	return bc
}

// ranks maps each value to the share of values strictly below it.
func ranks(v []float64) []float64 {
	sorted := append([]float64(nil), v...)
	sort.Float64s(sorted)
	out := make([]float64, len(v))
	if len(v) < 2 {
		return out
	}
	for i, x := range v {
		below := sort.SearchFloat64s(sorted, x)
		out[i] = float64(below) / float64(len(v)-1)
	}
	return out
}

// articulation finds cut vertices with an iterative Tarjan DFS, and for each
// the sizes of the parts left when it is removed (largest first).
func articulation(adj [][]int) ([]bool, [][]int) {
	n := len(adj)
	disc := make([]int, n)
	low := make([]int, n)
	size := make([]int, n) // DFS subtree size
	parent := make([]int, n)
	for i := range disc {
		disc[i], parent[i] = -1, -1
	}
	isArt := make([]bool, n)
	// separated[u] collects the subtree sizes that removing u cuts off.
	separated := make([][]int, n)
	timer := 0

	type frame struct{ v, next int }
	for root := 0; root < n; root++ {
		if disc[root] >= 0 {
			continue
		}
		// First pass over this component: DFS, low-links, subtree sizes.
		component := []int{}
		stack := []frame{{root, 0}}
		disc[root], low[root], size[root] = timer, timer, 1
		timer++
		component = append(component, root)
		for len(stack) > 0 {
			top := &stack[len(stack)-1]
			v := top.v
			if top.next < len(adj[v]) {
				w := adj[v][top.next]
				top.next++
				if disc[w] < 0 {
					parent[w] = v
					disc[w], low[w], size[w] = timer, timer, 1
					timer++
					component = append(component, w)
					stack = append(stack, frame{w, 0})
				} else if w != parent[v] && disc[w] < low[v] {
					low[v] = disc[w]
				}
				continue
			}
			stack = stack[:len(stack)-1]
			if p := parent[v]; p >= 0 {
				size[p] += size[v]
				if low[v] < low[p] {
					low[p] = low[v]
				}
				if low[v] >= disc[p] {
					separated[p] = append(separated[p], size[v])
				}
			}
		}

		total := len(component)
		for _, u := range component {
			parts := separated[u]
			if u == root {
				// The root separates its DFS children only when it has two or more.
				if len(parts) < 2 {
					separated[u] = nil
					continue
				}
			} else {
				if len(parts) == 0 {
					continue
				}
				rest := total - 1
				for _, s := range parts {
					rest -= s
				}
				if rest > 0 {
					parts = append(parts, rest)
				}
			}
			sort.Sort(sort.Reverse(sort.IntSlice(parts)))
			separated[u] = parts
			isArt[u] = true
		}
	}
	return isArt, separated
}
