// Package hub fans server-sent events out to connected browsers.
//
// SSE rather than WebSocket: the traffic is one-way, EventSource reconnects on
// its own, and it survives proxies without an upgrade handshake. Serve it over
// HTTP/2 (Caddy does by default) or the browser's six-connection-per-origin
// limit becomes a problem as soon as someone opens a few tabs.
package hub

import (
	"encoding/json"
	"sync"
	"sync/atomic"
)

// Event is one SSE message.
type Event struct {
	Name string
	Data []byte
}

// NewEvent marshals v into an event.
func NewEvent(name string, v any) (Event, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return Event{}, err
	}
	return Event{Name: name, Data: b}, nil
}

type client struct {
	ch     chan Event
	filter atomic.Pointer[string] // optional link id this client cares about
}

// Hub tracks subscribers.
type Hub struct {
	mu      sync.RWMutex
	clients map[*client]struct{}
	buffer  int
	dropped atomic.Uint64
}

// New returns a Hub with a per-client buffer of size buf.
func New(buf int) *Hub {
	if buf <= 0 {
		buf = 32
	}
	return &Hub{clients: make(map[*client]struct{}), buffer: buf}
}

// Subscription is a client's handle.
type Subscription struct {
	hub *Hub
	c   *client
}

// Events is the channel to read from.
func (s *Subscription) Events() <-chan Event { return s.c.ch }

// Follow limits per-link events to one link id. The map-wide events are always
// delivered; this only gates the high-rate per-frame stream.
func (s *Subscription) Follow(linkID string) { s.c.filter.Store(&linkID) }

// Close unsubscribes.
func (s *Subscription) Close() {
	s.hub.mu.Lock()
	delete(s.hub.clients, s.c)
	s.hub.mu.Unlock()
	close(s.c.ch)
}

// Subscribe registers a new client.
func (h *Hub) Subscribe() *Subscription {
	c := &client{ch: make(chan Event, h.buffer)}
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
	return &Subscription{hub: h, c: c}
}

// Broadcast sends to every client. A client whose buffer is full loses this
// event rather than slowing the pipeline: a stalled browser must never become
// backpressure on ingest.
func (h *Hub) Broadcast(e Event) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients {
		select {
		case c.ch <- e:
		default:
			h.dropped.Add(1)
		}
	}
}

// BroadcastTo sends only to clients following linkID.
func (h *Hub) BroadcastTo(linkID string, e Event) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients {
		f := c.filter.Load()
		if f == nil || *f != linkID {
			continue
		}
		select {
		case c.ch <- e:
		default:
			h.dropped.Add(1)
		}
	}
}

// Clients is the current subscriber count.
func (h *Hub) Clients() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

// Dropped counts events shed because a client could not keep up.
func (h *Hub) Dropped() uint64 { return h.dropped.Load() }
