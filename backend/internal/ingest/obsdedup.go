package ingest

import (
	"crypto/sha256"
	"sync"
	"time"

	"github.com/yvanferez/meshqual/backend/internal/source"
)

// ObsDedup drops an observation delivered twice: the same observer, direction
// and radio frame (path included) within ttl. That is one reception reaching
// relayd twice, typically an observer publishing to two brokers bridged into
// ours. Hearing a packet again over the air is not caught: a repeat by another
// repeater changes the path, a repeat by the observer itself is "tx".
type ObsDedup struct {
	mu    sync.Mutex
	ttl   time.Duration
	seen  map[[16]byte]time.Time
	calls int
}

// NewObsDedup keeps deliveries for ttl.
func NewObsDedup(ttl time.Duration) *ObsDedup {
	return &ObsDedup{ttl: ttl, seen: make(map[[16]byte]time.Time)}
}

// First reports whether this observation is new, and records it.
func (d *ObsDedup) First(o source.Observation, now time.Time) bool {
	h := sha256.New()
	h.Write([]byte(o.ObserverKey))
	h.Write([]byte{0})
	h.Write([]byte(o.Direction))
	h.Write([]byte{0})
	h.Write(o.Raw)
	var k [16]byte
	copy(k[:], h.Sum(nil))

	d.mu.Lock()
	defer d.mu.Unlock()
	if d.calls++; d.calls%1024 == 0 {
		for key, at := range d.seen {
			if now.Sub(at) > d.ttl {
				delete(d.seen, key)
			}
		}
	}
	if at, ok := d.seen[k]; ok && now.Sub(at) <= d.ttl {
		return false
	}
	d.seen[k] = now
	return true
}
