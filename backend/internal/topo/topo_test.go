package topo

import (
	"math"
	"reflect"
	"testing"
)

func graph(edges ...[2]string) *Graph {
	g := New()
	for _, e := range edges {
		g.AddEdge(e[0], e[1])
	}
	return g
}

// Two triangles joined only through X: X is the single relay between two
// clusters, which is what "critical" means.
func TestOnlyRelayBetweenTwoClustersIsCritical(t *testing.T) {
	a := Analyze(graph(
		[2]string{"A", "B"}, [2]string{"B", "C"}, [2]string{"C", "A"},
		[2]string{"D", "E"}, [2]string{"E", "F"}, [2]string{"F", "D"},
		[2]string{"C", "X"}, [2]string{"X", "D"},
	))
	x := a.Nodes["X"]
	if !x.Articulation || !reflect.DeepEqual(x.SplitSizes, []int{3, 3}) {
		t.Fatalf("X: articulation=%v split=%v, want true [3 3]", x.Articulation, x.SplitSizes)
	}
	if x.Level != LevelCritical {
		t.Errorf("X level = %s, want critical", x.Level)
	}
	// C also cuts the graph, but only A and B (2 nodes) hang off it: one
	// cluster on one side is not two clusters.
	c := a.Nodes["C"]
	if !c.Articulation || !reflect.DeepEqual(c.SplitSizes, []int{4, 2}) {
		t.Fatalf("C: articulation=%v split=%v, want true [4 2]", c.Articulation, c.SplitSizes)
	}
	if c.Level == LevelCritical {
		t.Error("C is critical, but what it cuts off is two nodes, not a cluster")
	}
	if a.Nodes["A"].Articulation || a.Nodes["A"].Level != LevelLow {
		t.Errorf("A = %+v, want a plain low node", a.Nodes["A"])
	}
}

// A hub with leaves keeps them connected, but leaves are not clusters.
func TestHubOfLeavesIsNotCritical(t *testing.T) {
	a := Analyze(graph([2]string{"H", "1"}, [2]string{"H", "2"}, [2]string{"H", "3"}))
	h := a.Nodes["H"]
	if !h.Articulation || !reflect.DeepEqual(h.SplitSizes, []int{1, 1, 1}) {
		t.Fatalf("H: articulation=%v split=%v", h.Articulation, h.SplitSizes)
	}
	if h.Level == LevelCritical || h.Level == LevelLow {
		t.Errorf("H level = %s, want medium or high", h.Level)
	}
}

func TestCycleHasNoBridge(t *testing.T) {
	a := Analyze(graph(
		[2]string{"A", "B"}, [2]string{"B", "C"}, [2]string{"C", "D"}, [2]string{"D", "A"},
	))
	for k, m := range a.Nodes {
		if m.Articulation || m.Level != LevelLow {
			t.Errorf("%s = %+v, want low with no articulation", k, m)
		}
	}
}

func TestBetweennessOnAPath(t *testing.T) {
	a := Analyze(graph([2]string{"A", "B"}, [2]string{"B", "C"}))
	if got := a.Nodes["B"].Betweenness; math.Abs(got-1) > 1e-9 {
		t.Errorf("B betweenness = %v, want 1: every path between others crosses it", got)
	}
	if got := a.Nodes["A"].Betweenness; got != 0 {
		t.Errorf("A betweenness = %v, want 0", got)
	}
	if a.NodeCount != 3 || a.EdgeCount != 2 {
		t.Errorf("counts = %d nodes %d edges, want 3 and 2", a.NodeCount, a.EdgeCount)
	}
}

func TestAnalysisIsDeterministic(t *testing.T) {
	edges := [][2]string{
		{"A", "B"}, {"B", "C"}, {"C", "A"}, {"C", "D"}, {"D", "E"}, {"E", "F"}, {"F", "D"},
	}
	first := Analyze(graph(edges...))
	for i := 0; i < 10; i++ {
		again := Analyze(graph(edges...))
		for k, m := range first.Nodes {
			if again.Nodes[k].Community != m.Community || again.Nodes[k].Level != m.Level {
				t.Fatalf("run %d: %s differs: %+v vs %+v", i, k, again.Nodes[k], m)
			}
		}
	}
}
