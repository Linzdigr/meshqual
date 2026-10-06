package api

import (
	"context"
	"errors"
	"math"
	"net/http"

	"github.com/yvanferez/meshqual/backend/internal/geo"
	"github.com/yvanferez/meshqual/backend/internal/los"
)

// Profiler returns ground samples between two points (los.IGN in production).
type Profiler interface {
	Profile(ctx context.Context, latA, lonA, latB, lonB float64, n int) ([]los.Point, error)
}

// profile serves the line of sight of a link, from its A node to its B node.
// Outside the elevation model's coverage it answers available:false rather
// than an error, so the panel can say why.
func (s *Server) profile(w http.ResponseWriter, r *http.Request) {
	if s.d.Profiles == nil {
		httpError(w, http.StatusNotFound, "line of sight is disabled")
		return
	}
	id, ok := s.linkID(r)
	if !ok {
		httpError(w, http.StatusBadRequest, "link keys required")
		return
	}
	a, okA := s.d.Resolver.Get(id.A)
	b, okB := s.d.Resolver.Get(id.B)
	if !okA || !okB || !a.HasPosition() || !b.HasPosition() {
		httpError(w, http.StatusNotFound, "both nodes need a known position")
		return
	}
	// About one sample every 30 m, within what the service answers quickly.
	distM := geo.HaversineKm(*a.Latitude, *a.Longitude, *b.Latitude, *b.Longitude) * 1000
	n := int(math.Max(40, math.Min(300, distM/30)))

	pts, err := s.d.Profiles.Profile(r.Context(), *a.Latitude, *a.Longitude, *b.Latitude, *b.Longitude, n)
	if errors.Is(err, los.ErrNoCoverage) {
		writeJSON(w, http.StatusOK, map[string]any{"available": false, "reason": "no_coverage"})
		return
	}
	if err != nil {
		s.d.Log.Warn("line of sight", "link", id.String(), "err", err)
		httpError(w, http.StatusBadGateway, "elevation service unavailable")
		return
	}
	res, ok := los.Analyze(pts, s.d.LosParams)
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{"available": false, "reason": "too_short"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"available": true,
		"freqMHz":   s.d.LosParams.FreqMHz,
		"antennaM":  s.d.LosParams.AntennaM,
		"result":    res,
	})
}
