// Package api exposes the HTTP surface: GeoJSON for the map, per-link detail,
// history and an SSE stream.
package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/yvanferez/meshqual/backend/internal/hub"
	"github.com/yvanferez/meshqual/backend/internal/ingest"
	"github.com/yvanferez/meshqual/backend/internal/source"
	"github.com/yvanferez/meshqual/backend/internal/store"
	"github.com/yvanferez/meshqual/backend/internal/topo"
)

// Deps is what the handlers need.
type Deps struct {
	Resolver   *ingest.Resolver
	Aggregator *ingest.Aggregator
	Pipeline   *ingest.Pipeline
	Store      store.Store
	Hub        *hub.Hub
	Sources    []source.Source
	Log        *slog.Logger

	CORSOrigins  []string
	PushInterval time.Duration
	LiveWindow   time.Duration
	FramesMax    int
	// AsymmetryThresholdDb is passed to the UI for its asymmetry view.
	AsymmetryThresholdDb float64
	Version              string
	StartedAt            time.Time
}

// Server holds the router.
type Server struct {
	d   Deps
	mux *http.ServeMux

	// The graph analysis behind /api/nodes/{key}, recomputed at most every
	// topoTTL: it is O(V·E) and a node panel does not need it fresher.
	topoMu    sync.Mutex
	topoAt    time.Time
	topoCache *topo.Analysis
}

// New builds the HTTP handler. Routing is stdlib ServeMux with method patterns,
// so there is no router dependency to keep current.
func New(d Deps) *Server {
	if d.FramesMax <= 0 {
		d.FramesMax = 20
	}
	s := &Server{d: d, mux: http.NewServeMux()}

	s.mux.HandleFunc("GET /api/health", s.health)
	s.mux.HandleFunc("GET /api/config", s.config)
	s.mux.HandleFunc("GET /api/nodes", s.nodes)
	s.mux.HandleFunc("GET /api/nodes/{key}", s.node)
	s.mux.HandleFunc("GET /api/links", s.links)
	s.mux.HandleFunc("GET /api/links/{a}/{b}", s.link)
	s.mux.HandleFunc("GET /api/links/{a}/{b}/frames", s.frames)
	s.mux.HandleFunc("GET /api/links/{a}/{b}/history", s.history)
	s.mux.HandleFunc("GET /api/stream", s.stream)
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.cors(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	s.mux.ServeHTTP(w, r)
}

func (s *Server) cors(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return
	}
	for _, allowed := range s.d.CORSOrigins {
		if allowed == "*" || strings.EqualFold(allowed, origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			return
		}
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	_ = enc.Encode(v)
}

func httpError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// bbox is a map viewport in degrees.
type bbox struct {
	MinLng, MinLat, MaxLng, MaxLat float64
	Set                            bool
}

func (b bbox) contains(lat, lng float64) bool {
	if !b.Set {
		return true
	}
	return lat >= b.MinLat && lat <= b.MaxLat && lng >= b.MinLng && lng <= b.MaxLng
}

// intersects reports whether a segment could be visible: either endpoint inside
// the box, or the segment's own bounds overlapping it. Cheap and conservative --
// it keeps long backbone links that cross the viewport without ending in it.
func (b bbox) intersects(a, c [2]float64) bool {
	if !b.Set {
		return true
	}
	if b.contains(a[1], a[0]) || b.contains(c[1], c[0]) {
		return true
	}
	minLng, maxLng := minMax(a[0], c[0])
	minLat, maxLat := minMax(a[1], c[1])
	return maxLng >= b.MinLng && minLng <= b.MaxLng && maxLat >= b.MinLat && minLat <= b.MaxLat
}

func minMax(x, y float64) (float64, float64) {
	if x < y {
		return x, y
	}
	return y, x
}

func parseBBox(r *http.Request) (bbox, error) {
	raw := r.URL.Query().Get("bbox")
	if raw == "" {
		return bbox{}, nil
	}
	parts := strings.Split(raw, ",")
	if len(parts) != 4 {
		return bbox{}, errBadBBox
	}
	vals := make([]float64, 4)
	for i, p := range parts {
		v, err := strconv.ParseFloat(strings.TrimSpace(p), 64)
		if err != nil {
			return bbox{}, errBadBBox
		}
		vals[i] = v
	}
	b := bbox{MinLng: vals[0], MinLat: vals[1], MaxLng: vals[2], MaxLat: vals[3], Set: true}
	if b.MinLng > b.MaxLng || b.MinLat > b.MaxLat {
		return bbox{}, errBadBBox
	}
	return b, nil
}

var errBadBBox = &apiError{"bbox must be minLng,minLat,maxLng,maxLat"}

type apiError struct{ msg string }

func (e *apiError) Error() string { return e.msg }

func intParam(r *http.Request, name string, def, max int) int {
	v, err := strconv.Atoi(r.URL.Query().Get(name))
	if err != nil || v <= 0 {
		return def
	}
	if max > 0 && v > max {
		return max
	}
	return v
}

func durParam(r *http.Request, name string, def time.Duration) time.Duration {
	raw := r.URL.Query().Get(name)
	if raw == "" {
		return def
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d <= 0 {
		return def
	}
	return d
}
