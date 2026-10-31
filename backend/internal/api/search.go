package api

import (
	"net/http"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"

	"github.com/yvanferez/meshqual/backend/internal/ingest"
	"github.com/yvanferez/meshqual/backend/internal/meshcore"
)

// SearchHit is one node found by name or key.
type SearchHit struct {
	Key        string  `json:"key"`
	Name       string  `json:"name"`
	NodeType   string  `json:"nodeType"`
	Lat        float64 `json:"lat"`
	Lon        float64 `json:"lon"`
	RegionName string  `json:"regionName,omitempty"`
	ListenOnly bool    `json:"listenOnly,omitempty"`
}

// fold lower-cases and strips accents, so "chateau" finds "Château".
func fold(s string) string {
	var b strings.Builder
	for _, r := range norm.NFD.String(s) {
		if !unicode.Is(unicode.Mn, r) {
			b.WriteRune(unicode.ToLower(r))
		}
	}
	return b.String()
}

// matchRank orders how well a name or key answers the query; -1 is no match.
// Whole name, then name start, then a word start, then anywhere in the name,
// then a public key prefix.
func matchRank(q, name, key string) int {
	switch i := strings.Index(name, q); {
	case name == q:
		return 0
	case i == 0:
		return 1
	case i > 0:
		// The best of every occurrence: one at a word start beats one inside.
		for j := i; j >= 0; {
			prev, _ := utf8.DecodeLastRuneInString(name[:j])
			if !unicode.IsLetter(prev) && !unicode.IsDigit(prev) {
				return 2
			}
			k := strings.Index(name[j+1:], q)
			if k < 0 {
				break
			}
			j += 1 + k
		}
		return 3
	}
	if strings.HasPrefix(key, strings.ToUpper(q)) {
		return 4
	}
	return -1
}

// searchNodes finds the nodes on the map whose name or key matches q, for the
// map's search field: the map itself only loads the nodes in view.
func (s *Server) searchNodes(w http.ResponseWriter, r *http.Request) {
	q := fold(strings.TrimSpace(r.URL.Query().Get("q")))
	limit := intParam(r, "limit", 8, 20)
	hits := []SearchHit{}
	if utf8.RuneCountInString(q) < 2 {
		writeJSON(w, http.StatusOK, map[string]any{"nodes": hits})
		return
	}

	type scored struct {
		n    ingest.Node
		rank int
	}
	var found []scored
	for _, n := range s.d.Resolver.Nodes() {
		if s.silent(n) || !n.HasPosition() {
			continue // not on the map: nothing to show or frame
		}
		if rank := matchRank(q, fold(n.Name), n.Key); rank >= 0 {
			found = append(found, scored{n, rank})
		}
	}
	sort.Slice(found, func(i, j int) bool {
		if found[i].rank != found[j].rank {
			return found[i].rank < found[j].rank
		}
		if !found[i].n.LastHeard.Equal(found[j].n.LastHeard) {
			return found[i].n.LastHeard.After(found[j].n.LastHeard)
		}
		return found[i].n.Name < found[j].n.Name
	})
	for _, f := range found[:min(len(found), limit)] {
		hits = append(hits, SearchHit{
			Key: f.n.Key, Name: f.n.Name, NodeType: meshcore.AdvTypeName(f.n.NodeType),
			Lat: *f.n.Latitude, Lon: *f.n.Longitude,
			RegionName: f.n.RegionName, ListenOnly: s.listenOnly(f.n),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"nodes": hits})
}
