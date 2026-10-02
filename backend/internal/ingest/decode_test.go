package ingest

import (
	"encoding/binary"
	"encoding/hex"
	"testing"
	"time"

	"github.com/yvanferez/meshqual/backend/internal/meshcore"
	"github.com/yvanferez/meshqual/backend/internal/source"
)

func pk(b byte) string {
	raw := make([]byte, 32)
	for i := range raw {
		raw[i] = b
	}
	// Make the first two bytes distinctive so 1- and 2-byte hashes differ per node.
	raw[0], raw[1] = b, b^0xA5
	return hexUp(raw)
}

func hexUp(b []byte) string {
	s := hex.EncodeToString(b)
	out := []byte(s)
	for i, c := range out {
		if c >= 'a' && c <= 'f' {
			out[i] = c - 32
		}
	}
	return string(out)
}

func hashOf(key string, width int) []byte { return decodeHex(key)[:width] }

func seedResolver(t *testing.T, keys ...string) *Resolver {
	t.Helper()
	r := NewResolver()
	for i, k := range keys {
		lat, lon := 48.0+float64(i)*0.1, -1.6+float64(i)*0.1
		r.Upsert(Node{Key: k, Name: "n" + string(rune('A'+i)), NodeType: meshcore.AdvTypeRepeater,
			Latitude: &lat, Longitude: &lon})
	}
	return r
}

func hdr(route, payload uint8) byte { return (route & 0x03) | ((payload & 0x0F) << 2) }

func plen(hops, size int) byte { return byte(hops&63) | byte((size-1)&0x03)<<6 }

func f64(v float64) *float64 { return &v }
func iptr(v int) *int        { return &v }

// buildFlood assembles a FLOOD frame whose path is the given node keys.
func buildFlood(keys []string, width int, payloadType uint8, body []byte) []byte {
	raw := []byte{hdr(meshcore.RouteFlood, payloadType), plen(len(keys), width)}
	for _, k := range keys {
		raw = append(raw, hashOf(k, width)...)
	}
	return append(raw, body...)
}

// TestObserverSNRGoesToLastHopOnly is the core claim of the whole model: the
// observer measured one link, so exactly one measured sample may come out, and
// every other pair in the path must be topology with no SNR.
func TestObserverSNRGoesToLastHopOnly(t *testing.T) {
	a, b, c, obs := pk(0x01), pk(0x02), pk(0x03), pk(0x09)
	r := seedResolver(t, a, b, c, obs)

	raw := buildFlood([]string{a, b, c}, 2, meshcore.PayloadGrpTxt, []byte("payload"))
	d, err := Decode(source.Observation{
		SourceID: "s1", ObserverKey: obs, ReceivedAt: time.Now().UTC(),
		SNR: f64(12.75), RSSI: iptr(-20), Raw: raw,
	}, r)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}

	var measured, topo int
	for _, s := range d.Samples {
		switch s.Kind {
		case KindMeasured:
			measured++
			if s.SNR == nil || *s.SNR != 12.75 {
				t.Errorf("measured sample SNR = %v, want 12.75", s.SNR)
			}
			// must be the C <-> observer pair
			if !pairIs(s, c, obs) {
				t.Errorf("measured pair = %s/%s, want last hop %s and observer %s", s.AKey, s.BKey, c, obs)
			}
		case KindTopology:
			topo++
			if s.SNR != nil {
				t.Errorf("topology sample carries SNR %v: adjacent hops have no measurement", *s.SNR)
			}
			if s.RSSI != nil {
				t.Errorf("topology sample carries RSSI %v", *s.RSSI)
			}
		default:
			t.Errorf("unexpected kind %s", s.Kind)
		}
	}
	if measured != 1 {
		t.Errorf("measured samples = %d, want exactly 1", measured)
	}
	if topo != 2 {
		t.Errorf("topology samples = %d, want 2 (A-B, B-C)", topo)
	}
}

func pairIs(s Sample, x, y string) bool {
	return (s.AKey == x && s.BKey == y) || (s.AKey == y && s.BKey == x)
}

func TestCanonicalOrderingAndDirection(t *testing.T) {
	lo, hi := pk(0x01), pk(0x02)
	if lo > hi {
		lo, hi = hi, lo
	}
	r := seedResolver(t, lo, hi)
	// path lo -> hi
	raw := buildFlood([]string{lo, hi}, 2, meshcore.PayloadTxtMsg, []byte("x"))
	d, _ := Decode(source.Observation{ObserverKey: "", Raw: raw, ReceivedAt: time.Now()}, r)
	if len(d.Samples) != 1 {
		t.Fatalf("samples = %d, want 1", len(d.Samples))
	}
	s := d.Samples[0]
	if s.AKey != lo || s.BKey != hi {
		t.Errorf("not canonically ordered: %s/%s", s.AKey, s.BKey)
	}
	if !s.Forward {
		t.Error("lo -> hi must be Forward")
	}

	// Reverse direction yields the same link id with Forward false.
	raw2 := buildFlood([]string{hi, lo}, 2, meshcore.PayloadTxtMsg, []byte("x"))
	d2, _ := Decode(source.Observation{Raw: raw2, ReceivedAt: time.Now()}, r)
	s2 := d2.Samples[0]
	if s2.ID() != s.ID() {
		t.Errorf("reverse traffic produced a different link id: %s vs %s", s2.ID(), s.ID())
	}
	if s2.Forward {
		t.Error("hi -> lo must not be Forward")
	}
}

func TestAmbiguousHashIsNotAttributed(t *testing.T) {
	// Two nodes sharing a 1-byte prefix: a 1-byte path hash cannot tell them apart.
	k1 := "AB" + hexUp(make([]byte, 31))
	k2raw := make([]byte, 32)
	k2raw[0], k2raw[1] = 0xAB, 0x01
	k2 := hexUp(k2raw)
	other := pk(0x44)
	r := seedResolver(t, k1, k2, other)

	h1 := meshcore.NewHash([]byte{0xAB})
	if res := r.Resolve(h1); !res.Ambiguous || res.Candidates != 2 {
		t.Fatalf("Resolve(AB) = %+v, want ambiguous with 2 candidates", res)
	}
	// 2-byte hashes separate them again.
	if res := r.Resolve(meshcore.NewHash([]byte{0xAB, 0x00})); !res.Resolved() {
		t.Errorf("2-byte hash should resolve uniquely, got %+v", res)
	}

	raw := append([]byte{hdr(meshcore.RouteFlood, meshcore.PayloadTxtMsg), plen(2, 1), 0xAB}, hashOf(other, 1)...)
	raw = append(raw, 'x')
	d, err := Decode(source.Observation{Raw: raw, ReceivedAt: time.Now()}, r)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if len(d.Samples) != 0 {
		t.Errorf("samples = %d, want 0: an ambiguous hop must not create an edge", len(d.Samples))
	}
	if d.HopsAmbiguous != 1 {
		t.Errorf("HopsAmbiguous = %d, want 1", d.HopsAmbiguous)
	}
	if d.HopsTotal != 2 {
		t.Errorf("HopsTotal = %d, want 2", d.HopsTotal)
	}
}

func TestUnknownHopIsCountedNotInvented(t *testing.T) {
	known := pk(0x01)
	r := seedResolver(t, known)
	// The second hop is one nobody has ever advertised.
	raw := []byte{hdr(meshcore.RouteFlood, meshcore.PayloadTxtMsg), plen(2, 2)}
	raw = append(raw, hashOf(known, 2)...)
	raw = append(raw, 0xFE, 0xED)
	raw = append(raw, 'x')

	d, _ := Decode(source.Observation{Raw: raw, ReceivedAt: time.Now()}, r)
	if len(d.Samples) != 0 {
		t.Errorf("samples = %d, want 0", len(d.Samples))
	}
	if d.HopsUnresolved != 1 {
		t.Errorf("HopsUnresolved = %d, want 1", d.HopsUnresolved)
	}
}

func TestLoopInPathIsNotALink(t *testing.T) {
	a := pk(0x01)
	r := seedResolver(t, a)
	raw := buildFlood([]string{a, a}, 2, meshcore.PayloadTxtMsg, []byte("x"))
	d, _ := Decode(source.Observation{Raw: raw, ReceivedAt: time.Now()}, r)
	for _, s := range d.Samples {
		if s.AKey == s.BKey {
			t.Error("a node linked to itself")
		}
	}
}

func TestAdvertSeedsNodeAndMeasuresDirectLink(t *testing.T) {
	obs := pk(0x09)
	r := seedResolver(t, obs)

	pub := make([]byte, 32)
	for i := range pub {
		pub[i] = byte(0xC0 + i%16)
	}
	var payload []byte
	payload = append(payload, pub...)
	payload = binary.LittleEndian.AppendUint32(payload, 1789825821)
	payload = append(payload, make([]byte, 64)...)
	payload = append(payload, meshcore.AdvTypeRepeater|0x10|0x80)
	payload = binary.LittleEndian.AppendUint32(payload, uint32(int32(48000550)))
	lonRaw := int32(-2253870)
	payload = binary.LittleEndian.AppendUint32(payload, uint32(lonRaw))
	payload = append(payload, []byte("fr35_Rpt-Broceliande")...)

	// Zero hops: heard straight from the advertiser.
	raw := append([]byte{hdr(meshcore.RouteFlood, meshcore.PayloadAdvert), plen(0, 1)}, payload...)

	d, err := Decode(source.Observation{
		ObserverKey: obs, Raw: raw, ReceivedAt: time.Now().UTC(), SNR: f64(-7.5), RSSI: iptr(-110),
	}, r)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if d.Advert == nil {
		t.Fatal("advert not decoded")
	}
	n, ok := r.Get(d.Advert.PublicKeyHex())
	if !ok {
		t.Fatal("advertiser was not added to the resolver")
	}
	if n.Name != "fr35_Rpt-Broceliande" || !n.HasPosition() {
		t.Errorf("node = %+v, want name and position", n)
	}
	if len(d.Samples) != 1 || d.Samples[0].Kind != KindMeasured {
		t.Fatalf("samples = %+v, want one measured sample", d.Samples)
	}
	if *d.Samples[0].SNR != -7.5 {
		t.Errorf("SNR = %v, want -7.5", *d.Samples[0].SNR)
	}
}

func TestTraceYieldsPerHopSNR(t *testing.T) {
	a, b, c := pk(0x01), pk(0x02), pk(0x03)
	r := seedResolver(t, a, b, c)

	snrs := []float64{9.5, -3.25} // hops a and b have forwarded
	raw := []byte{hdr(meshcore.RouteDirect, meshcore.PayloadTrace), plen(len(snrs), 1)}
	for _, s := range snrs {
		raw = append(raw, byte(int8(s*4)))
	}
	raw = binary.LittleEndian.AppendUint32(raw, 0x11223344)
	raw = binary.LittleEndian.AppendUint32(raw, 0)
	raw = append(raw, 0x01) // hash size 2
	for _, k := range []string{a, b, c} {
		raw = append(raw, hashOf(k, 2)...)
	}

	d, err := Decode(source.Observation{Raw: raw, ReceivedAt: time.Now().UTC(), ObserverKey: pk(0x09)}, r)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if d.Trace == nil {
		t.Fatal("trace not decoded")
	}
	if len(d.Samples) != 1 {
		t.Fatalf("samples = %d, want 1 (only hop 1 has both an SNR and a known predecessor)", len(d.Samples))
	}
	s := d.Samples[0]
	if s.Kind != KindTrace {
		t.Errorf("kind = %s, want trace", s.Kind)
	}
	if !pairIs(s, a, b) {
		t.Errorf("pair = %s/%s, want %s/%s", s.AKey, s.BKey, a, b)
	}
	if s.SNR == nil || *s.SNR != -3.25 {
		t.Errorf("SNR = %v, want -3.25 (the value hop b measured)", s.SNR)
	}
}

func TestNoObserverKeyMeansNoMeasuredSample(t *testing.T) {
	a, b := pk(0x01), pk(0x02)
	r := seedResolver(t, a, b)
	raw := buildFlood([]string{a, b}, 2, meshcore.PayloadTxtMsg, []byte("x"))
	d, _ := Decode(source.Observation{Raw: raw, ReceivedAt: time.Now(), SNR: f64(5)}, r)
	for _, s := range d.Samples {
		if s.Kind == KindMeasured {
			t.Error("measured sample emitted with no observer key: the SNR cannot be attributed")
		}
	}
}

func TestPositionIsNotErasedByLaterAdvert(t *testing.T) {
	r := NewResolver()
	lat, lon := 48.1, -1.7
	r.Upsert(Node{Key: pk(0x01), Name: "rpt", Latitude: &lat, Longitude: &lon})
	// A later advert without the lat/lon flag must not wipe the known position.
	r.Upsert(Node{Key: pk(0x01), Name: "rpt renamed"})
	n, _ := r.Get(pk(0x01))
	if !n.HasPosition() {
		t.Error("position erased by a positionless advert")
	}
	if n.Name != "rpt renamed" {
		t.Errorf("name = %q, want updated", n.Name)
	}
}

// TestDistantHopIsNotALink covers a hash that resolves uniquely to a node on
// another continent because the real local hop never advertised: the pair must
// be dropped and counted, for topology and for the measured link alike.
func TestDistantHopIsNotALink(t *testing.T) {
	local, remote, obs := pk(0x01), pk(0x02), pk(0x09)
	r := NewResolver()
	r.MaxHopKm = 300
	for _, n := range []struct {
		key      string
		lat, lon float64
	}{
		{local, 48.11, -1.68},   // Rennes
		{obs, 48.20, -1.60},     // Rennes area
		{remote, 32.90, -97.04}, // Dallas
	} {
		r.Upsert(Node{Key: n.key, Latitude: f64(n.lat), Longitude: f64(n.lon)})
	}

	raw := buildFlood([]string{local, remote}, 1, meshcore.PayloadGrpData, []byte("x"))
	d, err := Decode(source.Observation{
		ObserverKey: obs, ReceivedAt: time.Now().UTC(), SNR: f64(4), Raw: raw,
	}, r)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if len(d.Samples) != 0 {
		t.Errorf("got %d samples, want none: %+v", len(d.Samples), d.Samples)
	}
	if d.LinksImplausible != 2 {
		t.Errorf("LinksImplausible = %d, want 2 (topology + measured)", d.LinksImplausible)
	}

	// The same path stays valid once the check is off.
	r.MaxHopKm = 0
	d, _ = Decode(source.Observation{ObserverKey: obs, ReceivedAt: time.Now().UTC(), SNR: f64(4), Raw: raw}, r)
	if len(d.Samples) != 2 {
		t.Errorf("with MaxHopKm=0 got %d samples, want 2", len(d.Samples))
	}
}
