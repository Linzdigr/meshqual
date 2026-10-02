package api

import (
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/yvanferez/meshqual/backend/internal/geo"
	"github.com/yvanferez/meshqual/backend/internal/ingest"
	"github.com/yvanferez/meshqual/backend/internal/meshcore"
	"github.com/yvanferez/meshqual/backend/internal/source"
	"github.com/yvanferez/meshqual/backend/internal/store"
)

const maxLinkFeatures = 20000

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	srcStats := make([]source.Stats, 0, len(s.d.Sources))
	for _, src := range s.d.Sources {
		if rep, ok := src.(source.Reporter); ok {
			srcStats = append(srcStats, rep.Stats())
		} else {
			srcStats = append(srcStats, source.Stats{ID: src.ID(), Kind: "unknown"})
		}
	}
	dbOK := true
	if err := s.d.Store.Ping(r.Context()); err != nil {
		dbOK = false
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"version":       s.d.Version,
		"uptimeSeconds": int(time.Since(s.d.StartedAt).Seconds()),
		"database":      map[string]any{"ok": dbOK},
		"nodes":         s.d.Resolver.Len(),
		"attribution":   s.d.Aggregator.Health(),
		"pipeline":      s.d.Pipeline.Stats(),
		"sources":       srcStats,
		"sse":           map[string]any{"clients": s.d.Hub.Clients(), "dropped": s.d.Hub.Dropped()},
	})
}

// config tells the frontend the server's own parameters, so refresh cadence and
// SNR thresholds live in one place instead of being duplicated in the UI.
func (s *Server) config(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"pushIntervalMs": s.d.PushInterval.Milliseconds(),
		"liveWindow":     s.d.LiveWindow.String(),
		"framesMax":      s.d.FramesMax,
		// SNR bucket edges in dB. Four buckets, because the map encodes them as
		// an ordinal one-hue ramp: lightness carries the order, which stays
		// readable under colour-vision deficiency where a red/green scale does
		// not. Tune these to the spreading factor actually in use.
		"snrThresholds": []float64{-12, -5, 5},
		"snrRange":      []float64{-20, 15},
		// Gap between direction medians from which the asymmetry view
		// highlights a link.
		"asymmetryThresholdDb": s.d.AsymmetryThresholdDb,
	})
}

func (s *Server) nodes(w http.ResponseWriter, r *http.Request) {
	b, err := parseBBox(r)
	if err != nil {
		httpError(w, http.StatusBadRequest, err.Error())
		return
	}
	nodes := s.d.Resolver.Nodes()
	fc := newCollection(len(nodes))
	noPos := 0
	for _, n := range nodes {
		if !n.HasPosition() {
			noPos++
			continue
		}
		if !b.contains(*n.Latitude, *n.Longitude) {
			continue
		}
		fc.Features = append(fc.Features, pointFeature(n.Key, [2]float64{*n.Longitude, *n.Latitude},
			map[string]any{
				"key":      n.Key,
				"name":     n.Name,
				"nodeType": meshcore.AdvTypeName(n.NodeType),
			}))
	}
	fc.Meta = &Meta{
		GeneratedAt: time.Now().UTC().Format(time.RFC3339), Total: len(nodes),
		Returned: len(fc.Features), WithoutPosition: noPos,
	}
	writeJSON(w, http.StatusOK, fc)
}

// links serves the map layer as GeoJSON, straight from the in-memory aggregator.
func (s *Server) links(w http.ResponseWriter, r *http.Request) {
	b, err := parseBBox(r)
	if err != nil {
		httpError(w, http.StatusBadRequest, err.Error())
		return
	}
	minSamples := intParam(r, "minSamples", 1, 0)
	limit := intParam(r, "limit", maxLinkFeatures, maxLinkFeatures)

	wantKinds := map[ingest.Kind]bool{}
	if raw := r.URL.Query().Get("kind"); raw != "" {
		for _, k := range strings.Split(raw, ",") {
			if kind, ok := ingest.ParseKind(strings.TrimSpace(k)); ok {
				wantKinds[kind] = true
			}
		}
	}

	links := s.d.Aggregator.Snapshot()
	fc := newCollection(len(links))
	noPos := 0

	for _, l := range links {
		if l.Samples < minSamples {
			continue
		}
		if len(wantKinds) > 0 {
			k, _ := ingest.ParseKind(l.Kind)
			if !wantKinds[k] {
				continue
			}
		}
		na, okA := s.d.Resolver.Get(l.AKey)
		nb, okB := s.d.Resolver.Get(l.BKey)
		if !okA || !okB || !na.HasPosition() || !nb.HasPosition() {
			// A link whose endpoints have never advertised a position cannot be
			// drawn. Counted rather than dropped silently: on a young mesh this
			// is most of them, and the UI should say so.
			noPos++
			continue
		}
		pa := [2]float64{*na.Longitude, *na.Latitude}
		pb := [2]float64{*nb.Longitude, *nb.Latitude}
		if !b.intersects(pa, pb) {
			continue
		}

		props := map[string]any{
			"linkId":      l.ID.String(),
			"aKey":        l.AKey,
			"bKey":        l.BKey,
			"aName":       na.Name,
			"bName":       nb.Name,
			"kind":        l.Kind,
			"samples":     l.Samples,
			"forward":     l.Forward,
			"backward":    l.Backward,
			"lastSeen":    l.LastSeen.UTC().Format(time.RFC3339),
			"ageSec":      int(time.Since(l.LastSeen).Seconds()),
			"lastForward": l.LastForward,
			"distKm":      round2(geo.HaversineKm(*na.Latitude, *na.Longitude, *nb.Latitude, *nb.Longitude)),
			// Width is driven by traffic on a log scale: a backbone link carries
			// orders of magnitude more than a leaf, and a linear width would
			// make everything but the busiest pair invisible.
			"weight": round2(math.Log10(float64(l.Samples) + 1)),
		}
		if l.SNR != nil {
			props["snrMedian"] = l.SNR.Median
			props["snrP10"] = l.SNR.P10
			props["snrMin"] = l.SNR.Min
			props["snrMax"] = l.SNR.Max
			props["snrCount"] = l.SNR.Count
		}
		if l.Quality != nil {
			props["snrQuality"] = *l.Quality
			props["snrBasis"] = l.SNRBasis
		}
		if l.SNRAB != nil {
			props["snrMedianAB"] = l.SNRAB.Median
			props["snrP10AB"] = l.SNRAB.P10
			props["snrCountAB"] = l.SNRAB.Count
		}
		if l.SNRBA != nil {
			props["snrMedianBA"] = l.SNRBA.Median
			props["snrP10BA"] = l.SNRBA.P10
			props["snrCountBA"] = l.SNRBA.Count
		}
		if l.Delta != nil {
			props["snrDelta"] = *l.Delta
		}
		if l.LastSNR != nil {
			props["lastSnr"] = *l.LastSNR
		}
		if l.RSSIMean != nil {
			props["rssiMean"] = round2(*l.RSSIMean)
		}
		fc.Features = append(fc.Features, lineFeature(l.ID.String(), pa, pb, props))
	}

	// Busiest first, so a truncated response keeps the links that matter.
	sort.Slice(fc.Features, func(i, j int) bool {
		return toInt(fc.Features[i].Properties["samples"]) > toInt(fc.Features[j].Properties["samples"])
	})
	total := len(fc.Features)
	truncated := false
	if total > limit {
		fc.Features = fc.Features[:limit]
		truncated = true
	}

	h := s.d.Aggregator.Health()
	fc.Meta = &Meta{
		GeneratedAt: time.Now().UTC().Format(time.RFC3339),
		Window:      s.d.LiveWindow.String(),
		Total:       total, Returned: len(fc.Features), Truncated: truncated,
		WithoutPosition: noPos,
		UnresolvedShare: round4(h.UnresolvedShare),
		AmbiguousShare:  round4(h.AmbiguousShare),
	}
	writeJSON(w, http.StatusOK, fc)
}

func (s *Server) linkID(r *http.Request) (ingest.LinkID, bool) {
	a := strings.ToUpper(r.PathValue("a"))
	b := strings.ToUpper(r.PathValue("b"))
	if a == "" || b == "" {
		return ingest.LinkID{}, false
	}
	id, _ := ingest.NewLinkID(a, b)
	return id, true
}

func (s *Server) link(w http.ResponseWriter, r *http.Request) {
	id, ok := s.linkID(r)
	if !ok {
		httpError(w, http.StatusBadRequest, "link keys required")
		return
	}
	v, found := s.d.Aggregator.Get(id)
	if !found {
		httpError(w, http.StatusNotFound, "no live samples for this link")
		return
	}
	na, _ := s.d.Resolver.Get(id.A)
	nb, _ := s.d.Resolver.Get(id.B)
	out := map[string]any{"link": v, "a": na, "b": nb}
	if na.HasPosition() && nb.HasPosition() {
		out["distKm"] = round2(geo.HaversineKm(*na.Latitude, *na.Longitude, *nb.Latitude, *nb.Longitude))
	}
	writeJSON(w, http.StatusOK, out)
}

// frames serves the retained frames for one link out of memory: no database
// round trip, which is what makes the detail panel feel instant.
func (s *Server) frames(w http.ResponseWriter, r *http.Request) {
	id, ok := s.linkID(r)
	if !ok {
		httpError(w, http.StatusBadRequest, "link keys required")
		return
	}
	limit := intParam(r, "limit", 10, s.d.FramesMax)
	frames := s.d.Aggregator.Frames(id, limit)
	if frames == nil {
		frames = []ingest.Frame{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"linkId": id.String(),
		"limit":  limit,
		"max":    s.d.FramesMax,
		"frames": frames,
	})
}

func (s *Server) history(w http.ResponseWriter, r *http.Request) {
	id, ok := s.linkID(r)
	if !ok {
		httpError(w, http.StatusBadRequest, "link keys required")
		return
	}
	window := durParam(r, "window", 24*time.Hour)
	bucket := durParam(r, "bucket", time.Hour)
	buckets, err := s.d.Store.LinkHistory(r.Context(), id.A, id.B, time.Now().UTC().Add(-window), bucket)
	if buckets == nil {
		buckets = []store.Bucket{}
	}
	if err != nil {
		s.d.Log.Warn("link history failed", "link", id.String(), "err", err)
		httpError(w, http.StatusBadGateway, "history unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"linkId": id.String(), "window": window.String(), "bucket": bucket.String(),
		"buckets": buckets,
	})
}

func toInt(v any) int {
	if n, ok := v.(int); ok {
		return n
	}
	return 0
}

func round2(f float64) float64 { return math.Round(f*100) / 100 }
func round4(f float64) float64 { return math.Round(f*10000) / 10000 }
