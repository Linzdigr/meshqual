package ingest

import (
	"math"
	"sort"
	"sync"
	"time"
)

// Frame is one retained reception on a link, as shown in the detail panel.
type Frame struct {
	At          time.Time `json:"at"`
	Kind        string    `json:"kind"`
	Forward     bool      `json:"forward"`
	SNR         *float64  `json:"snr"`
	RSSI        *int      `json:"rssi"`
	PayloadType string    `json:"payloadType"`
	RouteType   string    `json:"routeType"`
	HopIndex    int       `json:"hopIndex"`
	HopCount    int       `json:"hopCount"`
	ObserverKey string    `json:"observerKey"`
	SourceID    string    `json:"sourceId"`
	WireHash    string    `json:"wireHash"`
}

// SNRStats is the exact distribution over the retained samples.
type SNRStats struct {
	Count  int     `json:"count"`
	Min    float64 `json:"min"`
	P10    float64 `json:"p10"`
	Median float64 `json:"median"`
	P90    float64 `json:"p90"`
	Max    float64 `json:"max"`
	Mean   float64 `json:"mean"`
}

// LinkState is the live, in-memory state of one link.
//
// The map is served from here rather than from SQL: a bbox query every couple of
// seconds against a hypertable would be the one thing that makes this expensive,
// and the live window is small enough to hold. Timescale keeps the history and
// answers the per-link time series.
type LinkState struct {
	ID   LinkID
	Kind Kind // the strongest kind seen: trace > measured > topology

	Samples   int
	Forward   int
	Backward  int
	FirstSeen time.Time
	LastSeen  time.Time

	// The newest sample: which way it went and the SNR it carried, if any. The
	// map animates a link in that direction for a few seconds after it is heard.
	LastForward bool
	LastSNR     *float64

	snr    []float64 // bounded ring of recent SNR values
	snrPos int
	rssi   []float64
	rssiP  int

	frames   []Frame // bounded ring, newest last
	framePos int

	Observers map[string]int
}

// Aggregator holds the live link table and the retained frames.
type Aggregator struct {
	mu    sync.RWMutex
	links map[LinkID]*LinkState

	maxFrames int
	maxSNR    int
	window    time.Duration
	dirty     map[LinkID]struct{}
	hopsTotal uint64
	hopsUnres uint64
	hopsAmbig uint64
	samplesIn uint64

	implausible uint64
}

// NewAggregator returns an aggregator retaining maxFrames frames and maxSNR SNR
// samples per link, and evicting links untouched for window.
func NewAggregator(maxFrames, maxSNR int, window time.Duration) *Aggregator {
	if maxFrames <= 0 {
		maxFrames = 20
	}
	if maxSNR <= 0 {
		maxSNR = 256
	}
	if window <= 0 {
		window = 24 * time.Hour
	}
	return &Aggregator{
		links:     make(map[LinkID]*LinkState),
		maxFrames: maxFrames,
		maxSNR:    maxSNR,
		window:    window,
		dirty:     make(map[LinkID]struct{}),
	}
}

// Add folds one decoded observation into the live table.
func (a *Aggregator) Add(d *Decoded) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.hopsTotal += uint64(d.HopsTotal)
	a.hopsUnres += uint64(d.HopsUnresolved)
	a.hopsAmbig += uint64(d.HopsAmbiguous)
	a.implausible += uint64(d.LinksImplausible)

	for _, s := range d.Samples {
		a.samplesIn++
		id := s.ID()
		st := a.links[id]
		if st == nil {
			st = &LinkState{ID: id, FirstSeen: s.At, Observers: map[string]int{}}
			a.links[id] = st
		}
		st.Samples++
		if s.Forward {
			st.Forward++
		} else {
			st.Backward++
		}
		if !s.At.Before(st.LastSeen) {
			st.LastSeen = s.At
			st.LastForward, st.LastSNR = s.Forward, s.SNR
		}
		if s.At.Before(st.FirstSeen) {
			st.FirstSeen = s.At
		}
		if s.Kind > st.Kind {
			st.Kind = s.Kind
		}
		if s.ObserverKey != "" {
			st.Observers[s.ObserverKey]++
		}
		if s.SNR != nil {
			st.snr, st.snrPos = pushRing(st.snr, st.snrPos, *s.SNR, a.maxSNR)
		}
		if s.RSSI != nil {
			st.rssi, st.rssiP = pushRing(st.rssi, st.rssiP, float64(*s.RSSI), a.maxSNR)
		}
		st.frames, st.framePos = pushFrame(st.frames, st.framePos, Frame{
			At: s.At, Kind: s.Kind.String(), Forward: s.Forward,
			SNR: s.SNR, RSSI: s.RSSI,
			PayloadType: payloadName(s.PayloadType), RouteType: routeName(s.RouteType),
			HopIndex: s.HopIndex, HopCount: s.HopCount,
			ObserverKey: s.ObserverKey, SourceID: s.SourceID, WireHash: s.WireHash,
		}, a.maxFrames)

		a.dirty[id] = struct{}{}
	}
}

// Snapshot returns a copy of every live link.
func (a *Aggregator) Snapshot() []LinkView {
	a.mu.RLock()
	defer a.mu.RUnlock()
	out := make([]LinkView, 0, len(a.links))
	for _, st := range a.links {
		out = append(out, st.view())
	}
	return out
}

// Get returns one link's view.
func (a *Aggregator) Get(id LinkID) (LinkView, bool) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	st, ok := a.links[id]
	if !ok {
		return LinkView{}, false
	}
	return st.view(), true
}

// Frames returns the most recent retained frames for a link, newest first.
func (a *Aggregator) Frames(id LinkID, limit int) []Frame {
	a.mu.RLock()
	defer a.mu.RUnlock()
	st, ok := a.links[id]
	if !ok {
		// Not nil: a nil slice marshals to JSON null, and a client that trusts
		// the field to be a list then crashes on an empty result.
		return []Frame{}
	}
	ordered := ringOrder(st.frames, st.framePos)
	// newest first
	for i, j := 0, len(ordered)-1; i < j; i, j = i+1, j-1 {
		ordered[i], ordered[j] = ordered[j], ordered[i]
	}
	if limit > 0 && len(ordered) > limit {
		ordered = ordered[:limit]
	}
	return ordered
}

// TakeDirty returns and clears the links changed since the last call. The SSE
// hub uses it to push a patch rather than make the client refetch everything.
func (a *Aggregator) TakeDirty() []LinkID {
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.dirty) == 0 {
		return nil
	}
	out := make([]LinkID, 0, len(a.dirty))
	for id := range a.dirty {
		out = append(out, id)
	}
	a.dirty = make(map[LinkID]struct{}, len(out))
	return out
}

// Evict drops links whose last sample is older than the window. Returns how many.
func (a *Aggregator) Evict(now time.Time) int {
	cutoff := now.Add(-a.window)
	a.mu.Lock()
	defer a.mu.Unlock()
	n := 0
	for id, st := range a.links {
		if st.LastSeen.Before(cutoff) {
			delete(a.links, id)
			delete(a.dirty, id)
			n++
		}
	}
	return n
}

// Health reports attribution quality: what share of observed hops could not be
// pinned to exactly one known node.
type Health struct {
	Links          int    `json:"links"`
	Samples        uint64 `json:"samples"`
	HopsTotal      uint64 `json:"hopsTotal"`
	HopsUnresolved uint64 `json:"hopsUnresolved"`
	HopsAmbiguous  uint64 `json:"hopsAmbiguous"`
	// LinksImplausible counts hop pairs rejected as too long for one radio hop.
	LinksImplausible uint64  `json:"linksImplausible"`
	UnresolvedShare  float64 `json:"unresolvedShare"`
	AmbiguousShare   float64 `json:"ambiguousShare"`
}

// Health returns the attribution counters.
func (a *Aggregator) Health() Health {
	a.mu.RLock()
	defer a.mu.RUnlock()
	h := Health{
		Links: len(a.links), Samples: a.samplesIn,
		HopsTotal: a.hopsTotal, HopsUnresolved: a.hopsUnres, HopsAmbiguous: a.hopsAmbig,
		LinksImplausible: a.implausible,
	}
	if a.hopsTotal > 0 {
		h.UnresolvedShare = float64(a.hopsUnres) / float64(a.hopsTotal)
		h.AmbiguousShare = float64(a.hopsAmbig) / float64(a.hopsTotal)
	}
	return h
}

// LinkView is the serialisable form of a link.
type LinkView struct {
	ID        LinkID    `json:"-"`
	AKey      string    `json:"aKey"`
	BKey      string    `json:"bKey"`
	Kind      string    `json:"kind"`
	Samples   int       `json:"samples"`
	Forward   int       `json:"forward"`
	Backward  int       `json:"backward"`
	FirstSeen time.Time `json:"firstSeen"`
	LastSeen  time.Time `json:"lastSeen"`
	// LastForward and LastSNR describe the newest sample only.
	LastForward bool           `json:"lastForward"`
	LastSNR     *float64       `json:"lastSnr"`
	SNR         *SNRStats      `json:"snr"`
	RSSIMean    *float64       `json:"rssiMean"`
	Observers   map[string]int `json:"observers"`
}

func (st *LinkState) view() LinkView {
	v := LinkView{
		ID: st.ID, AKey: st.ID.A, BKey: st.ID.B, Kind: st.Kind.String(),
		Samples: st.Samples, Forward: st.Forward, Backward: st.Backward,
		FirstSeen: st.FirstSeen, LastSeen: st.LastSeen,
		LastForward: st.LastForward, LastSNR: st.LastSNR,
		Observers: make(map[string]int, len(st.Observers)),
	}
	for k, n := range st.Observers {
		v.Observers[k] = n
	}
	if s := stats(st.snr); s != nil {
		v.SNR = s
	}
	if len(st.rssi) > 0 {
		m := mean(st.rssi)
		v.RSSIMean = &m
	}
	return v
}

func stats(vals []float64) *SNRStats {
	if len(vals) == 0 {
		return nil
	}
	s := make([]float64, len(vals))
	copy(s, vals)
	sort.Float64s(s)
	return &SNRStats{
		Count: len(s), Min: s[0], Max: s[len(s)-1],
		P10: quantile(s, 0.10), Median: quantile(s, 0.50), P90: quantile(s, 0.90),
		Mean: round2(mean(s)),
	}
}

// quantile is linear interpolation on a sorted slice (the type-7 definition, the
// same one numpy and R default to).
func quantile(sorted []float64, q float64) float64 {
	if len(sorted) == 1 {
		return sorted[0]
	}
	pos := q * float64(len(sorted)-1)
	lo := int(math.Floor(pos))
	hi := int(math.Ceil(pos))
	if lo == hi {
		return round2(sorted[lo])
	}
	frac := pos - float64(lo)
	return round2(sorted[lo]*(1-frac) + sorted[hi]*frac)
}

func mean(v []float64) float64 {
	var s float64
	for _, x := range v {
		s += x
	}
	return s / float64(len(v))
}

func round2(f float64) float64 { return math.Round(f*100) / 100 }

func pushRing(ring []float64, pos int, v float64, max int) ([]float64, int) {
	if len(ring) < max {
		return append(ring, v), len(ring) + 1
	}
	ring[pos%max] = v
	return ring, pos + 1
}

func pushFrame(ring []Frame, pos int, v Frame, max int) ([]Frame, int) {
	if len(ring) < max {
		return append(ring, v), len(ring) + 1
	}
	ring[pos%max] = v
	return ring, pos + 1
}

// ringOrder returns ring contents oldest-first.
func ringOrder[T any](ring []T, pos int) []T {
	n := len(ring)
	out := make([]T, 0, n)
	if n == 0 {
		return out
	}
	if pos <= n {
		out = append(out, ring...)
		return out
	}
	start := pos % n
	out = append(out, ring[start:]...)
	out = append(out, ring[:start]...)
	return out
}
