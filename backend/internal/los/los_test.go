package los

import (
	"context"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
)

var params = Params{FreqMHz: 869.525, AntennaM: 10, K: 4.0 / 3.0}

func flat(totalM float64, n int, ground func(d float64) float64) []Point {
	pts := make([]Point, n)
	for i := range pts {
		d := totalM * float64(i) / float64(n-1)
		pts[i] = Point{DistM: d, GroundM: ground(d)}
	}
	return pts
}

func TestFlatShortPathIsClear(t *testing.T) {
	r, ok := Analyze(flat(2000, 50, func(float64) float64 { return 50 }), params)
	if !ok || r.Verdict != Clear {
		t.Fatalf("verdict = %s (clearance %v), want clear", r.Verdict, r.Clearance)
	}
	if r.DistanceKm != 2 {
		t.Errorf("distance = %v km, want 2", r.DistanceKm)
	}
}

func TestHillBetweenBlocks(t *testing.T) {
	// A 60 m ridge in the middle of a 5 km path, antennas 10 m above flat ground.
	hill := func(d float64) float64 {
		if math.Abs(d-2500) < 200 {
			return 60
		}
		return 0
	}
	r, ok := Analyze(flat(5000, 101, hill), params)
	if !ok || r.Verdict != Blocked || r.Clearance >= 0 {
		t.Fatalf("verdict = %s (clearance %v), want blocked", r.Verdict, r.Clearance)
	}
	if math.Abs(r.Worst.DistKm-2.5) > 0.25 {
		t.Errorf("worst point at %v km, want near the ridge at 2.5 km", r.Worst.DistKm)
	}
}

func TestEarthBulgeMattersOverDistance(t *testing.T) {
	// 40 km over flat ground with 10 m masts: the bulge (~23 m at mid-path with
	// k=4/3) rises above the line, which flat geometry alone would miss.
	r, ok := Analyze(flat(40000, 201, func(float64) float64 { return 0 }), params)
	if !ok || r.Verdict != Blocked {
		t.Fatalf("verdict = %s (clearance %v), want blocked by the earth's bulge", r.Verdict, r.Clearance)
	}
	mid := r.Samples[100]
	if mid.TerrainM < 20 || mid.TerrainM > 26 {
		t.Errorf("mid-path bulge = %v m, want about 23", mid.TerrainM)
	}
}

func TestFresnelEncroachedIsPartial(t *testing.T) {
	// A bump that stays below the line but enters the Fresnel zone.
	bump := func(d float64) float64 {
		if math.Abs(d-1000) < 50 {
			return 5
		}
		return 0
	}
	r, ok := Analyze(flat(2000, 81, bump), params)
	if !ok || r.Verdict != Partial {
		t.Fatalf("verdict = %s (clearance %v), want partial", r.Verdict, r.Clearance)
	}
}

func TestIGNProfileParsesAndCaches(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Query().Get("sampling") != "3" || r.URL.Query().Get("resource") != "ign_rge_alti_wld" {
			t.Errorf("query = %s", r.URL.RawQuery)
		}
		_, _ = w.Write([]byte(`{"elevations":[{"lon":-1.68,"lat":48.11,"z":29.3},{"lon":-1.64,"lat":48.115,"z":35.9},{"lon":-1.60,"lat":48.12,"z":32.7}]}`))
	}))
	defer srv.Close()
	c := NewIGN(srv.URL, "ign_rge_alti_wld")
	for i := 0; i < 2; i++ {
		pts, err := c.Profile(context.Background(), 48.11, -1.68, 48.12, -1.60, 3)
		if err != nil {
			t.Fatal(err)
		}
		if len(pts) != 3 || pts[0].DistM != 0 || pts[1].GroundM != 35.9 || pts[2].DistM < 5000 {
			t.Fatalf("points = %+v", pts)
		}
	}
	if calls != 1 {
		t.Errorf("service called %d times, want 1 (cached)", calls)
	}
}

func TestIGNNoDataIsNoCoverage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"elevations":[{"lon":-97.9,"lat":30.4,"z":-99999},{"lon":-97.8,"lat":30.4,"z":-99999}]}`))
	}))
	defer srv.Close()
	_, err := NewIGN(srv.URL, "x").Profile(context.Background(), 30.4, -97.9, 30.4, -97.8, 2)
	if err != ErrNoCoverage {
		t.Errorf("err = %v, want ErrNoCoverage", err)
	}
}
