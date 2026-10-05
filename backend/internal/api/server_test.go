package api

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/yvanferez/meshqual/backend/internal/hub"
	"github.com/yvanferez/meshqual/backend/internal/ingest"
	"github.com/yvanferez/meshqual/backend/internal/meshcore"
	"github.com/yvanferez/meshqual/backend/internal/source"
	"github.com/yvanferez/meshqual/backend/internal/store"
)

func keyFor(b byte) string {
	raw := make([]byte, 32)
	for i := range raw {
		raw[i] = b
	}
	raw[0], raw[1] = b, b^0x5A
	return strings.ToUpper(hex.EncodeToString(raw))
}

func hashBytes(key string, w int) []byte {
	b, _ := hex.DecodeString(key)
	return b[:w]
}

func advertFrame(key string, lat, lon float64, name string, nodeType uint8) []byte {
	pub, _ := hex.DecodeString(key)
	var payload []byte
	payload = append(payload, pub...)
	payload = binary.LittleEndian.AppendUint32(payload, uint32(time.Now().Unix()))
	payload = append(payload, make([]byte, 64)...)
	payload = append(payload, nodeType|0x10|0x80)
	payload = binary.LittleEndian.AppendUint32(payload, uint32(int32(lat*1e6)))
	payload = binary.LittleEndian.AppendUint32(payload, uint32(int32(lon*1e6)))
	payload = append(payload, []byte(name)...)
	hdr := byte(meshcore.RouteFlood) | byte(meshcore.PayloadAdvert)<<2
	return append([]byte{hdr, 0x00}, payload...)
}

func floodFrame(keys []string, width int) []byte {
	hdr := byte(meshcore.RouteFlood) | byte(meshcore.PayloadGrpTxt)<<2
	plen := byte(len(keys)&63) | byte((width-1)&0x03)<<6
	raw := []byte{hdr, plen}
	for _, k := range keys {
		raw = append(raw, hashBytes(k, width)...)
	}
	return append(raw, []byte("body")...)
}

type fixture struct {
	srv        *Server
	resolver   *ingest.Resolver
	aggregator *ingest.Aggregator
	a, b, obs  string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	resolver := ingest.NewResolver()
	aggregator := ingest.NewAggregator(20, 256, time.Hour)
	events := hub.New(16)
	st := store.Noop{}
	pipe := ingest.NewPipeline(resolver, aggregator, store.Sink{S: st}, events, ingest.PipelineOptions{}, log)

	f := &fixture{resolver: resolver, aggregator: aggregator,
		a: keyFor(0x11), b: keyFor(0x22), obs: keyFor(0x33)}

	// Everyone advertises, so the resolver learns identities and positions.
	for _, n := range []struct {
		key      string
		lat, lon float64
		name     string
	}{
		{f.a, 48.1173, -1.6778, "fr35_Rpt-Rennes"},
		{f.b, 48.0006, -2.2539, "fr35_Rpt-Broceliande"},
		{f.obs, 47.9086, -1.9871, "fr35_Observer"},
	} {
		d, err := ingest.Decode(source.Observation{
			SourceID: "test", Raw: advertFrame(n.key, n.lat, n.lon, n.name, meshcore.AdvTypeRepeater),
			ReceivedAt: time.Now().UTC(),
		}, resolver)
		if err != nil {
			t.Fatalf("advert decode: %v", err)
		}
		aggregator.Add(d)
	}

	f.srv = New(Deps{
		Resolver: resolver, Aggregator: aggregator, Pipeline: pipe, Store: st, Hub: events,
		Sources: nil, Log: log, PushInterval: 2 * time.Second, LiveWindow: time.Hour,
		FramesMax: 20, Version: "test", StartedAt: time.Now(),
		CORSOrigins: []string{"http://localhost:5173"},
	})
	return f
}

// feed injects one observation through the real decode path.
func (f *fixture) feed(t *testing.T, raw []byte, observer string, snr *float64, rssi *int) {
	t.Helper()
	d, err := ingest.Decode(source.Observation{
		SourceID: "test", ObserverKey: observer, ReceivedAt: time.Now().UTC(),
		SNR: snr, RSSI: rssi, Raw: raw,
	}, f.resolver)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	f.aggregator.Add(d)
}

func (f *fixture) get(t *testing.T, url string) (*http.Response, []byte) {
	t.Helper()
	rec := httptest.NewRecorder()
	f.srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, url, nil))
	res := rec.Result()
	body, _ := io.ReadAll(res.Body)
	return res, body
}

func ptrF(v float64) *float64 { return &v }
func ptrI(v int) *int         { return &v }

func TestLinksGeoJSONContract(t *testing.T) {
	f := newFixture(t)
	f.feed(t, floodFrame([]string{f.a, f.b}, 2), f.obs, ptrF(8.25), ptrI(-95))
	f.feed(t, floodFrame([]string{f.a, f.b}, 2), f.obs, ptrF(6.00), ptrI(-99))

	res, body := f.get(t, "/api/links")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d: %s", res.StatusCode, body)
	}
	var fc FeatureCollection
	if err := json.Unmarshal(body, &fc); err != nil {
		t.Fatalf("unmarshal: %v\n%s", err, body)
	}
	if fc.Type != "FeatureCollection" {
		t.Errorf("type = %q", fc.Type)
	}
	if len(fc.Features) == 0 {
		t.Fatalf("no features: %s", body)
	}
	if fc.Meta == nil {
		t.Fatal("meta missing: the UI needs it to state attribution quality")
	}

	var measured, topology int
	for _, ft := range fc.Features {
		if ft.Geometry.Type != "LineString" {
			t.Errorf("geometry = %q, want LineString", ft.Geometry.Type)
		}
		coords, ok := ft.Geometry.Coordinates.([]any)
		if !ok || len(coords) != 2 {
			t.Fatalf("coordinates = %v", ft.Geometry.Coordinates)
		}
		// GeoJSON is [lng, lat]: getting this backwards puts Brittany in Somalia.
		first := coords[0].([]any)
		lng, lat := first[0].(float64), first[1].(float64)
		if lng < -5 || lng > 0 {
			t.Errorf("longitude %v is not in Brittany: coordinate order is wrong", lng)
		}
		if lat < 46 || lat > 50 {
			t.Errorf("latitude %v is not in Brittany: coordinate order is wrong", lat)
		}
		for _, k := range []string{"linkId", "aKey", "bKey", "aName", "bName", "kind", "samples", "weight", "distKm", "lastSeen"} {
			if _, ok := ft.Properties[k]; !ok {
				t.Errorf("property %q missing from %v", k, ft.Properties)
			}
		}
		switch ft.Properties["kind"] {
		case "measured":
			measured++
			if _, ok := ft.Properties["snrMedian"]; !ok {
				t.Error("measured link has no snrMedian")
			}
		case "topology":
			topology++
			if _, ok := ft.Properties["snrMedian"]; ok {
				t.Error("topology link exposes snrMedian: there is no measurement for it")
			}
		}
	}
	if measured != 1 {
		t.Errorf("measured links = %d, want 1 (last hop -> observer)", measured)
	}
	if topology != 1 {
		t.Errorf("topology links = %d, want 1 (A-B)", topology)
	}
}

func TestLinksBBoxFiltersAndMetaCounts(t *testing.T) {
	f := newFixture(t)
	f.feed(t, floodFrame([]string{f.a, f.b}, 2), f.obs, ptrF(5), ptrI(-90))

	// A box over the Alps contains nothing in Brittany.
	_, body := f.get(t, "/api/links?bbox=5.0,44.0,7.0,46.0")
	var fc FeatureCollection
	_ = json.Unmarshal(body, &fc)
	if len(fc.Features) != 0 {
		t.Errorf("features = %d outside the bbox", len(fc.Features))
	}

	// A box over Brittany contains them.
	_, body = f.get(t, "/api/links?bbox=-3.0,47.0,-1.0,49.0")
	_ = json.Unmarshal(body, &fc)
	if len(fc.Features) == 0 {
		t.Error("no features inside the Brittany bbox")
	}
}

func TestLinksBadBBoxIsRejected(t *testing.T) {
	f := newFixture(t)
	for _, bad := range []string{"1,2,3", "a,b,c,d", "5,10,1,20"} {
		res, _ := f.get(t, "/api/links?bbox="+bad)
		if res.StatusCode != http.StatusBadRequest {
			t.Errorf("bbox %q: status %d, want 400", bad, res.StatusCode)
		}
	}
}

func TestLinksKindFilter(t *testing.T) {
	f := newFixture(t)
	f.feed(t, floodFrame([]string{f.a, f.b}, 2), f.obs, ptrF(5), ptrI(-90))

	_, body := f.get(t, "/api/links?kind=measured")
	var fc FeatureCollection
	_ = json.Unmarshal(body, &fc)
	if len(fc.Features) != 1 {
		t.Fatalf("features = %d, want 1", len(fc.Features))
	}
	if fc.Features[0].Properties["kind"] != "measured" {
		t.Errorf("kind = %v", fc.Features[0].Properties["kind"])
	}
}

func TestFramesEndpointNewestFirstAndCapped(t *testing.T) {
	f := newFixture(t)
	for i := 0; i < 5; i++ {
		f.feed(t, floodFrame([]string{f.a, f.b}, 2), f.obs, ptrF(float64(i)), ptrI(-90))
	}
	id, _ := ingest.NewLinkID(f.b, f.obs) // the measured link
	_, body := f.get(t, "/api/links/"+id.A+"/"+id.B+"/frames?limit=3")

	var out struct {
		LinkID string         `json:"linkId"`
		Frames []ingest.Frame `json:"frames"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("unmarshal: %v\n%s", err, body)
	}
	if len(out.Frames) != 3 {
		t.Fatalf("frames = %d, want 3", len(out.Frames))
	}
	if out.Frames[0].SNR == nil || *out.Frames[0].SNR != 4 {
		t.Errorf("newest frame SNR = %v, want 4", out.Frames[0].SNR)
	}
	for i := 1; i < len(out.Frames); i++ {
		if out.Frames[i].At.After(out.Frames[i-1].At) {
			t.Error("frames are not newest-first")
		}
	}
	// Key order must not matter: the link id is canonical.
	_, body2 := f.get(t, "/api/links/"+id.B+"/"+id.A+"/frames?limit=3")
	var out2 struct {
		LinkID string `json:"linkId"`
	}
	_ = json.Unmarshal(body2, &out2)
	if out2.LinkID != out.LinkID {
		t.Errorf("reversed keys gave a different link id: %s vs %s", out2.LinkID, out.LinkID)
	}
}

func TestLinkNotFound(t *testing.T) {
	f := newFixture(t)
	res, _ := f.get(t, "/api/links/"+keyFor(0xAA)+"/"+keyFor(0xBB))
	if res.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d, want 404", res.StatusCode)
	}
}

func TestNodesGeoJSON(t *testing.T) {
	f := newFixture(t)
	_, body := f.get(t, "/api/nodes")
	var fc FeatureCollection
	if err := json.Unmarshal(body, &fc); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(fc.Features) != 3 {
		t.Fatalf("features = %d, want 3", len(fc.Features))
	}
	for _, ft := range fc.Features {
		if ft.Geometry.Type != "Point" {
			t.Errorf("geometry = %q", ft.Geometry.Type)
		}
		if ft.Properties["nodeType"] != "repeater" {
			t.Errorf("nodeType = %v, want repeater", ft.Properties["nodeType"])
		}
	}
}

func TestHealthAndConfig(t *testing.T) {
	f := newFixture(t)
	res, body := f.get(t, "/api/health")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("health status %d", res.StatusCode)
	}
	var h map[string]any
	_ = json.Unmarshal(body, &h)
	for _, k := range []string{"version", "attribution", "pipeline", "sources", "sse", "nodes"} {
		if _, ok := h[k]; !ok {
			t.Errorf("health missing %q", k)
		}
	}

	_, body = f.get(t, "/api/config")
	var c struct {
		PushIntervalMs int64     `json:"pushIntervalMs"`
		SNRThresholds  []float64 `json:"snrThresholds"`
	}
	_ = json.Unmarshal(body, &c)
	if c.PushIntervalMs != 2000 {
		t.Errorf("pushIntervalMs = %d, want 2000", c.PushIntervalMs)
	}
	if len(c.SNRThresholds) != 3 {
		t.Errorf("snrThresholds = %v, want 3 edges for 4 buckets", c.SNRThresholds)
	}
}

func TestCORSAllowlist(t *testing.T) {
	f := newFixture(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/links", nil)
	req.Header.Set("Origin", "http://localhost:5173")
	f.srv.ServeHTTP(rec, req)
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:5173" {
		t.Errorf("allow-origin = %q", got)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/links", nil)
	req.Header.Set("Origin", "https://evil.example")
	f.srv.ServeHTTP(rec, req)
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("unlisted origin was allowed: %q", got)
	}
}

func TestStreamSendsHello(t *testing.T) {
	f := newFixture(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/stream?link=A:B", nil)
	ctx, cancel := context.WithTimeout(req.Context(), 150*time.Millisecond)
	defer cancel()
	f.srv.ServeHTTP(rec, req.WithContext(ctx))

	body := rec.Body.String()
	if !strings.Contains(body, "event: hello") {
		t.Errorf("no hello event:\n%s", body)
	}
	if !strings.Contains(body, "retry:") {
		t.Errorf("no retry hint:\n%s", body)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Errorf("content-type = %q", ct)
	}
}

// TestNoNullSlicesInJSON guards a sharp edge of encoding/json: a nil Go slice
// marshals to `null`, not `[]`. A client that reasonably treats these fields as
// lists then crashes on an empty result -- which is exactly what the detail panel
// did until this was fixed.
func TestNoNullSlicesInJSON(t *testing.T) {
	f := newFixture(t)
	unknown := keyFor(0xAA) + "/" + keyFor(0xBB)

	cases := map[string][]string{
		"/api/links":                         {`"features":null`},
		"/api/nodes":                         {`"features":null`},
		"/api/links/" + unknown + "/frames":  {`"frames":null`},
		"/api/links/" + unknown + "/history": {`"buckets":null`},
		"/api/health":                        {`"sources":null`},
	}
	for url, forbidden := range cases {
		res, body := f.get(t, url)
		if res.StatusCode != http.StatusOK {
			t.Errorf("%s: status %d", url, res.StatusCode)
			continue
		}
		for _, bad := range forbidden {
			if strings.Contains(string(body), bad) {
				t.Errorf("%s: response contains %s\n%s", url, bad, body)
			}
		}
		// And the fields must actually parse as arrays.
		var generic map[string]json.RawMessage
		if err := json.Unmarshal(body, &generic); err != nil {
			t.Errorf("%s: %v", url, err)
			continue
		}
		for _, key := range []string{"features", "frames", "buckets", "sources"} {
			raw, ok := generic[key]
			if !ok {
				continue
			}
			var arr []json.RawMessage
			if err := json.Unmarshal(raw, &arr); err != nil {
				t.Errorf("%s: %q is not an array: %s", url, key, raw)
			}
		}
	}
}

func TestNodeDetailNeighboursAndBackbone(t *testing.T) {
	f := newFixture(t)
	// Path a -> b heard by obs: a-b is topology, b-obs is measured by obs.
	f.feed(t, floodFrame([]string{f.a, f.b}, 2), f.obs, ptrF(8.25), ptrI(-95))
	f.feed(t, floodFrame([]string{f.a, f.b}, 2), f.obs, ptrF(6.00), ptrI(-99))

	// Keys are accepted in any case.
	res, body := f.get(t, "/api/nodes/"+strings.ToLower(f.b))
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d: %s", res.StatusCode, body)
	}
	var got struct {
		Node      struct{ Key, Name, NodeType string }
		Neighbors []struct {
			Key         string
			Kind        string
			SnrToNode   *float64
			SnrFromNode *float64
			DistKm      *float64
		}
		Backbone struct {
			Articulation bool
			SplitSizes   []int
			Level        string
			Reasons      []string
		}
		LastSeen string
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v\n%s", err, body)
	}
	if got.Node.Key != f.b || got.Node.Name != "fr35_Rpt-Broceliande" || got.Node.NodeType != "repeater" {
		t.Errorf("node = %+v", got.Node)
	}
	if len(got.Neighbors) != 2 {
		t.Fatalf("neighbours = %d, want a and obs: %s", len(got.Neighbors), body)
	}
	// The measured link sorts first (it has an SNR), and its SNR is what obs
	// measured hearing b: "from" the node's point of view, never "to".
	first := got.Neighbors[0]
	if first.Key != f.obs || first.Kind != "measured" {
		t.Errorf("first neighbour = %+v, want the measured obs link", first)
	}
	if first.SnrFromNode == nil || first.SnrToNode != nil {
		t.Errorf("obs link: to=%v from=%v, want only from (obs heard b)", first.SnrToNode, first.SnrFromNode)
	}
	if first.DistKm == nil {
		t.Error("distance missing between two positioned nodes")
	}
	// b sits between a and obs on a path: removing it splits them.
	if !got.Backbone.Articulation || len(got.Backbone.Reasons) == 0 {
		t.Errorf("backbone = %+v, want an articulation with reasons", got.Backbone)
	}
	if got.Backbone.Level == "critical" {
		t.Error("b only separates single nodes, which is not critical")
	}
	if got.LastSeen == "" {
		t.Error("lastSeen missing")
	}

	if res, _ := f.get(t, "/api/nodes/"+keyFor(0x99)); res.StatusCode != http.StatusNotFound {
		t.Errorf("unknown node: status %d, want 404", res.StatusCode)
	}
}

func TestNodesHidesSilentNodes(t *testing.T) {
	f := newFixture(t)
	f.srv.d.NodeMaxAge = 48 * time.Hour
	// The fixture's adverts were just heard; make one node silent for 3 days.
	f.resolver.Upsert(ingest.Node{Key: keyFor(0x44), Name: "silent",
		Latitude: ptrF(48.2), Longitude: ptrF(-1.7), LastHeard: time.Now().Add(-72 * time.Hour)})

	_, body := f.get(t, "/api/nodes")
	var fc FeatureCollection
	if err := json.Unmarshal(body, &fc); err != nil {
		t.Fatal(err)
	}
	keys := map[string]bool{}
	for _, ft := range fc.Features {
		keys[ft.Properties["key"].(string)] = true
	}
	if keys[keyFor(0x44)] {
		t.Error("a node silent for 72h is still on the map")
	}
	if !keys[f.a] || !keys[f.b] {
		t.Errorf("recently heard nodes missing: %v", keys)
	}
	// Still known: its detail answers, for shared links and path resolution.
	if res, _ := f.get(t, "/api/nodes/"+keyFor(0x44)); res.StatusCode != http.StatusOK {
		t.Errorf("silent node detail: status %d, want 200", res.StatusCode)
	}
}
