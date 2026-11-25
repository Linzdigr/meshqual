package api

import (
	"net/http"
	"testing"
	"time"

	"github.com/yvanferez/meshqual/backend/internal/meshcore"
	"github.com/yvanferez/meshqual/backend/internal/store"
)

func TestParsePacketHash(t *testing.T) {
	if h, ok := parsePacketHash(" 23adb40bcda9a241 "); !ok || h != "23ADB40BCDA9A241" {
		t.Fatalf("got %q %v", h, ok)
	}
	for _, bad := range []string{"", "23adb40b", "23adb40bcda9a2411", "zzadb40bcda9a241"} {
		if _, ok := parsePacketHash(bad); ok {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestBuildPacketTrace(t *testing.T) {
	f := newFixture(t)
	snr := 4.5
	rows := []store.ObservationRow{
		// A flood advert from a, relayed by a, b and an unknown node, heard by obs.
		{At: time.Now(), ObserverKey: f.obs, RouteType: meshcore.RouteFlood, PayloadType: meshcore.PayloadAdvert,
			HashSize: 1, Path: []byte{0x11, 0x22, 0x99}, SNR: &snr, OriginKey: f.a},
		{At: time.Now(), ObserverKey: f.obs, RouteType: meshcore.RouteDirect, PayloadType: meshcore.PayloadAdvert, HashSize: 1},
	}
	tr := buildPacketTrace("23ADB40BCDA9A241", rows, f.resolver)
	if tr.PayloadType != "ADVERT" || tr.Origin == nil || tr.Origin.Name != "fr35_Rpt-Rennes" {
		t.Fatalf("header: %+v", tr)
	}
	r0 := tr.Receptions[0]
	if r0.Observer.Name != "fr35_Observer" || r0.Route != "flood" || len(r0.Hops) != 3 {
		t.Fatalf("reception: %+v", r0)
	}
	if r0.Hops[0].Key != f.a || r0.Hops[1].Key != f.b || r0.Hops[2].Key != "" || r0.Hops[2].Hash != "99" {
		t.Fatalf("hops: %+v", r0.Hops)
	}
	if r0.Hops[0].Lat == nil {
		t.Fatal("hop without position")
	}
	if tr.Receptions[1].Route != "direct" || len(tr.Receptions[1].Hops) != 0 {
		t.Fatalf("direct: %+v", tr.Receptions[1])
	}
}

func TestPacketRoute(t *testing.T) {
	f := newFixture(t)
	if res, _ := f.get(t, "/api/packets/xyz"); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad hash: %d", res.StatusCode)
	}
	// The no-op store keeps nothing.
	if res, _ := f.get(t, "/api/packets/23adb40bcda9a241"); res.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown: %d", res.StatusCode)
	}
}
