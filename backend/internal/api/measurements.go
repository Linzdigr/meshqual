package api

import (
	"crypto/subtle"
	"encoding/json"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/yvanferez/meshqual/backend/internal/ingest"
	"github.com/yvanferez/meshqual/backend/internal/meshcore"
)

// measurementRequest is what the browser sends after a trace came back to
// its companion, or after a discovery: hops in the order they were measured.
type measurementRequest struct {
	// Companion is the public key of the radio that sent the trace.
	Companion string `json:"companion"`
	// Source is "trace" or "discovery".
	Source string `json:"source"`
	// Tag is the trace's (or discovery's) random tag.
	Tag  uint32           `json:"tag"`
	At   time.Time        `json:"at"`
	Hops []measurementHop `json:"hops"`
}

type measurementHop struct {
	From string  `json:"from"`
	To   string  `json:"to"`
	SNR  float64 `json:"snr"`
}

const (
	maxMeasurementHops = 64
	// A trace's SNR byte holds a quarter dB: -32 to +31.75 dB.
	minHopSNR, maxHopSNR = -32.0, 32.0
	// Per client: a campaign runs a trace every ~10 s, so this leaves room.
	measurementsPerMinute = 30
)

// measurements records what a companion radio measured, sent in by the
// browser driving it (POST /api/measurements). Observers only hear part of a
// trace; the companion gets every hop. Off without a submit token.
func (s *Server) measurements(w http.ResponseWriter, r *http.Request) {
	if s.d.SubmitToken == "" || s.d.Pipeline == nil {
		httpError(w, http.StatusNotFound, "measurement submission is disabled")
		return
	}
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if subtle.ConstantTimeCompare([]byte(token), []byte(s.d.SubmitToken)) != 1 {
		httpError(w, http.StatusUnauthorized, "bad token")
		return
	}
	if !s.limiter.allow(clientIP(r), time.Now()) {
		httpError(w, http.StatusTooManyRequests, "too many submissions")
		return
	}

	var req measurementRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		httpError(w, http.StatusBadRequest, "bad json")
		return
	}
	companion := strings.ToUpper(req.Companion)
	if !isKey(companion) || (req.Source != "trace" && req.Source != "discovery") ||
		len(req.Hops) == 0 || len(req.Hops) > maxMeasurementHops {
		httpError(w, http.StatusBadRequest, "need companion, source trace|discovery and 1-64 hops")
		return
	}
	// The browser's clock decides when, within reason.
	now := time.Now().UTC()
	at := req.At.UTC()
	if at.IsZero() || at.After(now.Add(time.Minute)) || at.Before(now.Add(-10*time.Minute)) {
		at = now
	}
	payload := meshcore.PayloadTrace
	if req.Source == "discovery" {
		payload = meshcore.PayloadControl
	}

	var samples []ingest.Sample
	skipped := map[string]int{}
	for i, h := range req.Hops {
		from, to := strings.ToUpper(h.From), strings.ToUpper(h.To)
		switch {
		case !isKey(from) || !isKey(to) || from == to || h.SNR < minHopSNR || h.SNR > maxHopSNR:
			skipped["invalid"]++
			continue
		case !s.known(from) || !s.known(to):
			skipped["unknown"]++
			continue
		case !s.d.Resolver.Plausible(from, to):
			skipped["implausible"]++
			continue
		}
		snr := h.SNR
		a, b, fwd := order(from, to)
		samples = append(samples, ingest.Sample{
			At: at, AKey: a, BKey: b, Forward: fwd, Kind: ingest.KindTrace, SNR: &snr,
			ObserverKey: companion, SourceID: ingest.SourceCompanion,
			PayloadType: payload, RouteType: meshcore.RouteDirect,
			HopIndex: i, HopCount: len(req.Hops),
		})
	}
	kept := 0
	if len(samples) > 0 {
		kept = s.d.Pipeline.AddCompanionSamples(req.Tag, samples)
		skipped["duplicate"] = len(samples) - kept
	}
	writeJSON(w, http.StatusOK, map[string]any{"accepted": kept, "skipped": skipped})
}

func (s *Server) known(key string) bool {
	_, ok := s.d.Resolver.Get(key)
	return ok
}

func order(from, to string) (a, b string, forward bool) {
	id, fwd := ingest.NewLinkID(from, to)
	return id.A, id.B, fwd
}

func isKey(k string) bool {
	if len(k) != 64 {
		return false
	}
	for _, c := range k {
		if !(c >= '0' && c <= '9' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}

func clientIP(r *http.Request) string {
	// Behind Caddy: the first forwarded address is the client.
	if f := r.Header.Get("X-Forwarded-For"); f != "" {
		return strings.TrimSpace(strings.Split(f, ",")[0])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// rateLimiter allows a number of calls per client per minute.
type rateLimiter struct {
	mu     sync.Mutex
	perMin int
	calls  map[string][]time.Time
}

func newRateLimiter(perMin int) *rateLimiter {
	return &rateLimiter{perMin: perMin, calls: make(map[string][]time.Time)}
}

func (l *rateLimiter) allow(client string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	recent := l.calls[client][:0]
	for _, t := range l.calls[client] {
		if now.Sub(t) < time.Minute {
			recent = append(recent, t)
		}
	}
	if len(recent) >= l.perMin {
		l.calls[client] = recent
		return false
	}
	l.calls[client] = append(recent, now)
	return true
}
