package api

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/yvanferez/meshqual/backend/internal/ingest"
)

func TestMatchRank(t *testing.T) {
	for _, c := range []struct {
		q, name string
		want    int
	}{
		{"rennes", "rennes", 0},
		{"ren", "rennes-nord", 1},
		{"nord", "rennes-nord", 2},
		{"enn", "rennes", 3},
		{"no", "kenoa nord", 2}, // a later occurrence at a word start counts
		{"ab12", "zzz", 4},      // key prefix
		{"xyz", "rennes", -1},
	} {
		if got := matchRank(c.q, c.name, "AB12CD"); got != c.want {
			t.Errorf("matchRank(%q, %q) = %d, want %d", c.q, c.name, got, c.want)
		}
	}
	if fold("Château-Gîron") != "chateau-giron" {
		t.Errorf("fold = %q", fold("Château-Gîron"))
	}
}

func TestSearchNodes(t *testing.T) {
	f := newFixture(t)
	f.srv.d.NodeMaxAge = 48 * time.Hour
	now := time.Now()
	f.resolver.Upsert(ingest.Node{Key: keyFor(0x51), Name: "Château Rennes", Latitude: ptrF(48.1), Longitude: ptrF(-1.6), LastHeard: now})
	f.resolver.Upsert(ingest.Node{Key: keyFor(0x52), Name: "Le Chateau", Latitude: ptrF(48.2), Longitude: ptrF(-1.7), LastHeard: now})
	f.resolver.Upsert(ingest.Node{Key: keyFor(0x53), Name: "chateau silencieux", Latitude: ptrF(48.2), Longitude: ptrF(-1.7), LastHeard: now.Add(-72 * time.Hour)})
	f.resolver.Upsert(ingest.Node{Key: keyFor(0x54), Name: "chateau sans position", LastHeard: now})

	_, body := f.get(t, "/api/nodes/search?q=chateau")
	var res struct{ Nodes []SearchHit }
	if err := json.Unmarshal(body, &res); err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, n := range res.Nodes {
		names = append(names, n.Name)
	}
	if len(names) != 2 || names[0] != "Château Rennes" || names[1] != "Le Chateau" {
		t.Errorf("hits = %v, want [Château Rennes, Le Chateau]", names)
	}

	_, body = f.get(t, "/api/nodes/search?q=c")
	if string(body) != "{\"nodes\":[]}\n" {
		t.Errorf("one letter answered %s", body)
	}
}
