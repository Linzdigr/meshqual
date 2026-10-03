package api

import (
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/yvanferez/meshqual/backend/internal/geo"
	"github.com/yvanferez/meshqual/backend/internal/ingest"
	"github.com/yvanferez/meshqual/backend/internal/meshcore"
	"github.com/yvanferez/meshqual/backend/internal/topo"
)

const topoTTL = 15 * time.Second

// analysis returns the graph analysis of every live link, recomputed when stale.
// Every link kind counts: a topology link proves two nodes hear each other,
// which is all connectivity needs.
func (s *Server) analysis(links []ingest.LinkView) *topo.Analysis {
	s.topoMu.Lock()
	defer s.topoMu.Unlock()
	if s.topoCache != nil && time.Since(s.topoAt) < topoTTL {
		return s.topoCache
	}
	g := topo.New()
	for _, l := range links {
		g.AddEdge(l.AKey, l.BKey)
	}
	s.topoCache, s.topoAt = topo.Analyze(g), time.Now()
	return s.topoCache
}

type nodeInfo struct {
	Key       string   `json:"key"`
	Name      string   `json:"name"`
	NodeType  string   `json:"nodeType"`
	Latitude  *float64 `json:"lat"`
	Longitude *float64 `json:"lon"`
}

type neighbor struct {
	nodeInfo
	LinkID  string `json:"linkId"`
	Kind    string `json:"kind"`
	Samples int    `json:"samples"`
	// Quality is the link's weaker-direction SNR (see ingest.LinkView).
	Quality  *float64 `json:"snrQuality"`
	SNRBasis string   `json:"snrBasis,omitempty"`
	// ToNode and FromNode are the direction medians as seen from this node:
	// what it measured hearing the neighbour, and what the neighbour measured.
	ToNode   *float64 `json:"snrToNode"`
	FromNode *float64 `json:"snrFromNode"`
	DistKm   *float64 `json:"distKm"`
	LastSeen string   `json:"lastSeen"`
	AgeSec   int      `json:"ageSec"`
	// Community is the neighbour's group, to show which groups the node touches.
	Community *int `json:"community"`
}

// node serves one node: what is known about it, its neighbours on live links,
// and how much the observed mesh depends on it to stay connected.
func (s *Server) node(w http.ResponseWriter, r *http.Request) {
	key := strings.ToUpper(r.PathValue("key"))
	n, ok := s.d.Resolver.Get(key)
	if !ok {
		httpError(w, http.StatusNotFound, "unknown node")
		return
	}
	links := s.d.Aggregator.Snapshot()
	an := s.analysis(links)

	var last time.Time
	neighbors := []neighbor{}
	for _, l := range links {
		var other string
		switch key {
		case l.AKey:
			other = l.BKey
		case l.BKey:
			other = l.AKey
		default:
			continue
		}
		if l.LastSeen.After(last) {
			last = l.LastSeen
		}
		nb := neighbor{
			nodeInfo: s.info(other),
			LinkID:   l.ID.String(), Kind: l.Kind, Samples: l.Samples,
			Quality: l.Quality, SNRBasis: l.SNRBasis,
			LastSeen: l.LastSeen.UTC().Format(time.RFC3339),
			AgeSec:   int(time.Since(l.LastSeen).Seconds()),
		}
		// AB is what B measured hearing A.
		toNode, fromNode := l.SNRBA, l.SNRAB
		if key == l.BKey {
			toNode, fromNode = l.SNRAB, l.SNRBA
		}
		if toNode != nil {
			nb.ToNode = &toNode.Median
		}
		if fromNode != nil {
			nb.FromNode = &fromNode.Median
		}
		if n.HasPosition() && nb.Latitude != nil && nb.Longitude != nil {
			d := round2(geo.HaversineKm(*n.Latitude, *n.Longitude, *nb.Latitude, *nb.Longitude))
			nb.DistKm = &d
		}
		if m := an.Nodes[other]; m != nil {
			c := m.Community
			nb.Community = &c
		}
		neighbors = append(neighbors, nb)
	}
	// Best links first; links with no SNR (topology) after, busiest first.
	sort.Slice(neighbors, func(i, j int) bool {
		qi, qj := neighbors[i].Quality, neighbors[j].Quality
		if (qi == nil) != (qj == nil) {
			return qi != nil
		}
		if qi != nil && *qi != *qj {
			return *qi > *qj
		}
		return neighbors[i].Samples > neighbors[j].Samples
	})

	out := map[string]any{
		"node":      s.info(key),
		"neighbors": neighbors,
		"graph": map[string]any{
			"nodes": an.NodeCount, "links": an.EdgeCount, "communities": an.Communities,
		},
	}
	if m := an.Nodes[key]; m != nil {
		out["backbone"] = m
	}
	if !last.IsZero() {
		out["lastSeen"] = last.UTC().Format(time.RFC3339)
		out["ageSec"] = int(time.Since(last).Seconds())
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) info(key string) nodeInfo {
	n, _ := s.d.Resolver.Get(key)
	return nodeInfo{
		Key: key, Name: n.Name, NodeType: meshcore.AdvTypeName(n.NodeType),
		Latitude: n.Latitude, Longitude: n.Longitude,
	}
}
