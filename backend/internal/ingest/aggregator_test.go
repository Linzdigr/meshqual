package ingest

import (
	"math"
	"testing"
	"time"
)

func sampleAt(a, b string, kind Kind, snr *float64, at time.Time) Sample {
	id, fwd := NewLinkID(a, b)
	return Sample{At: at, AKey: id.A, BKey: id.B, Forward: fwd, Kind: kind, SNR: snr, ObserverKey: "OBS"}
}

func TestAggregatorStatsAreExact(t *testing.T) {
	ag := NewAggregator(10, 256, time.Hour)
	now := time.Now().UTC()
	vals := []float64{-10, -5, 0, 2, 4, 6, 8, 10, 12, 20}
	for i, v := range vals {
		ag.Add(&Decoded{Samples: []Sample{sampleAt("A", "B", KindMeasured, f64(v), now.Add(time.Duration(i)*time.Second))}})
	}
	v, ok := ag.Get(LinkID{A: "A", B: "B"})
	if !ok {
		t.Fatal("link missing")
	}
	if v.SNR == nil {
		t.Fatal("no SNR stats")
	}
	if v.SNR.Count != 10 || v.SNR.Min != -10 || v.SNR.Max != 20 {
		t.Errorf("stats = %+v", v.SNR)
	}
	// median of the 10 values above = (4+6)/2 = 5
	if math.Abs(v.SNR.Median-5) > 1e-9 {
		t.Errorf("median = %v, want 5", v.SNR.Median)
	}
	if v.Samples != 10 {
		t.Errorf("samples = %d", v.Samples)
	}
}

func TestAggregatorKeepsStrongestKind(t *testing.T) {
	ag := NewAggregator(10, 64, time.Hour)
	now := time.Now().UTC()
	ag.Add(&Decoded{Samples: []Sample{sampleAt("A", "B", KindTopology, nil, now)}})
	if v, _ := ag.Get(LinkID{A: "A", B: "B"}); v.Kind != "topology" {
		t.Errorf("kind = %s, want topology", v.Kind)
	}
	ag.Add(&Decoded{Samples: []Sample{sampleAt("A", "B", KindMeasured, f64(3), now)}})
	if v, _ := ag.Get(LinkID{A: "A", B: "B"}); v.Kind != "measured" {
		t.Errorf("kind = %s, want measured to win over topology", v.Kind)
	}
	ag.Add(&Decoded{Samples: []Sample{sampleAt("A", "B", KindTrace, f64(3), now)}})
	if v, _ := ag.Get(LinkID{A: "A", B: "B"}); v.Kind != "trace" {
		t.Errorf("kind = %s, want trace to win", v.Kind)
	}
	// A later topology sample must not downgrade it.
	ag.Add(&Decoded{Samples: []Sample{sampleAt("A", "B", KindTopology, nil, now)}})
	if v, _ := ag.Get(LinkID{A: "A", B: "B"}); v.Kind != "trace" {
		t.Errorf("kind downgraded to %s", v.Kind)
	}
}

func TestFrameRingIsNewestFirstAndBounded(t *testing.T) {
	ag := NewAggregator(3, 64, time.Hour)
	base := time.Now().UTC()
	for i := 0; i < 7; i++ {
		ag.Add(&Decoded{Samples: []Sample{sampleAt("A", "B", KindMeasured, f64(float64(i)), base.Add(time.Duration(i)*time.Second))}})
	}
	fr := ag.Frames(LinkID{A: "A", B: "B"}, 10)
	if len(fr) != 3 {
		t.Fatalf("frames = %d, want 3 (ring bound)", len(fr))
	}
	if *fr[0].SNR != 6 || *fr[1].SNR != 5 || *fr[2].SNR != 4 {
		t.Errorf("frames not newest-first: %v %v %v", *fr[0].SNR, *fr[1].SNR, *fr[2].SNR)
	}
	for i := 1; i < len(fr); i++ {
		if fr[i].At.After(fr[i-1].At) {
			t.Errorf("frame %d is newer than %d", i, i-1)
		}
	}
}

func TestDirtyTrackingAndEviction(t *testing.T) {
	ag := NewAggregator(5, 64, time.Minute)
	now := time.Now().UTC()
	ag.Add(&Decoded{Samples: []Sample{sampleAt("A", "B", KindMeasured, f64(1), now)}})
	ag.Add(&Decoded{Samples: []Sample{sampleAt("C", "D", KindTopology, nil, now)}})
	d := ag.TakeDirty()
	if len(d) != 2 {
		t.Fatalf("dirty = %d, want 2", len(d))
	}
	if again := ag.TakeDirty(); len(again) != 0 {
		t.Errorf("dirty not cleared: %v", again)
	}

	// Nothing is evicted inside the window.
	if n := ag.Evict(now); n != 0 {
		t.Errorf("evicted %d inside the window", n)
	}
	if n := ag.Evict(now.Add(2 * time.Minute)); n != 2 {
		t.Errorf("evicted %d, want 2", n)
	}
	if h := ag.Health(); h.Links != 0 {
		t.Errorf("links = %d after eviction", h.Links)
	}
}

func TestHealthShares(t *testing.T) {
	ag := NewAggregator(5, 64, time.Hour)
	ag.Add(&Decoded{HopsTotal: 10, HopsUnresolved: 2, HopsAmbiguous: 3})
	h := ag.Health()
	if math.Abs(h.UnresolvedShare-0.2) > 1e-9 || math.Abs(h.AmbiguousShare-0.3) > 1e-9 {
		t.Errorf("shares = %+v", h)
	}
}

func TestAggregatorTracksNewestSample(t *testing.T) {
	ag := NewAggregator(10, 256, time.Hour)
	now := time.Now().UTC()
	ag.Add(&Decoded{Samples: []Sample{sampleAt("A", "B", KindMeasured, f64(3), now)}})
	ag.Add(&Decoded{Samples: []Sample{sampleAt("B", "A", KindTopology, nil, now.Add(time.Second))}})
	// An older sample arriving late must not overwrite the newest one.
	ag.Add(&Decoded{Samples: []Sample{sampleAt("A", "B", KindMeasured, f64(9), now.Add(-time.Second))}})

	v, _ := ag.Get(LinkID{A: "A", B: "B"})
	if v.LastForward {
		t.Error("LastForward = true, want false: the newest sample went B -> A")
	}
	if v.LastSNR != nil {
		t.Errorf("LastSNR = %v, want nil: the newest sample carried no SNR", *v.LastSNR)
	}
}
