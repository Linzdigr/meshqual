package ingest

import (
	"sync"
	"time"
)

// SourceCompanion marks samples a companion radio measured and the browser
// driving it sent in (api POST /api/measurements), as opposed to what an
// observer heard over the air.
const SourceCompanion = "companion"

// TraceDedup remembers, for a few minutes, which hops of which trace (by its
// random tag) are already recorded. One trace reaches the server several ways:
// an observer hears it at each retransmission, every one carrying the SNR of
// the hops before, and the companion's browser sends the full result. Each
// hop and direction should count once.
type TraceDedup struct {
	mu    sync.Mutex
	ttl   time.Duration
	seen  map[traceHopKey]time.Time
	calls int
}

type traceHopKey struct {
	tag      uint32
	from, to string
}

// NewTraceDedup keeps hops for ttl.
func NewTraceDedup(ttl time.Duration) *TraceDedup {
	return &TraceDedup{ttl: ttl, seen: make(map[traceHopKey]time.Time)}
}

// First reports whether this hop of this trace is new, and records it.
func (d *TraceDedup) First(tag uint32, from, to string, now time.Time) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.calls++; d.calls%256 == 0 {
		for k, at := range d.seen {
			if now.Sub(at) > d.ttl {
				delete(d.seen, k)
			}
		}
	}
	k := traceHopKey{tag, from, to}
	if at, ok := d.seen[k]; ok && now.Sub(at) <= d.ttl {
		return false
	}
	d.seen[k] = now
	return true
}

// sampleFrom and sampleTo are a sample's sender and receiver.
func sampleFrom(s Sample) string {
	if s.Forward {
		return s.AKey
	}
	return s.BKey
}

func sampleTo(s Sample) string {
	if s.Forward {
		return s.BKey
	}
	return s.AKey
}
