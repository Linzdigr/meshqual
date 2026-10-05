// Package ingest turns raw observations into node facts and link samples.
package ingest

import (
	"strings"
	"sync"
	"time"

	"github.com/yvanferez/meshqual/backend/internal/geo"
	"github.com/yvanferez/meshqual/backend/internal/meshcore"
)

// Node is what the resolver knows about a node, learned from ADVERT packets.
type Node struct {
	Key       string // full public key, uppercase hex
	Name      string
	NodeType  uint8
	Latitude  *float64
	Longitude *float64
	// PathHashSize is the path hash width (1..4 bytes) the node uses for packets
	// it originates, read from its adverts; 0 until one is seen.
	PathHashSize uint8
	// LastHeard is the last time the node was heard: an advert from it, a path
	// that unambiguously names it as a relay, or a packet it observed. The map
	// hides nodes silent for too long (see api Deps.NodeMaxAge).
	LastHeard time.Time
}

// HasPosition reports whether this node can be drawn on a map.
func (n *Node) HasPosition() bool { return n.Latitude != nil && n.Longitude != nil }

// Resolution is the outcome of mapping a path hash back to a node.
//
// Ambiguity is a first-class result, not an error. A 1-byte path hash has only
// 256 values, so on a mesh of a few hundred nodes collisions are routine; a link
// built from an ambiguous hop would be a fabricated edge. The counters let the
// API report how much of the traffic could not be attributed, which is the
// honest denominator for everything else on the map.
type Resolution struct {
	Key        string
	Ambiguous  bool
	Candidates int
}

// Resolved reports whether exactly one node answers to the hash.
func (r Resolution) Resolved() bool { return r.Key != "" && !r.Ambiguous }

// Resolver maps path hashes to node public keys.
type Resolver struct {
	// MaxHopKm bounds the length of a single radio hop. Zero disables the check.
	// Set it before the resolver is shared.
	MaxHopKm float64

	mu    sync.RWMutex
	nodes map[string]*Node
	// byHash indexes every node under each hash width the format allows, so a
	// lookup is O(1) regardless of the width the sender chose.
	byHash map[meshcore.Hash][]string
}

// NewResolver returns an empty resolver.
func NewResolver() *Resolver {
	return &Resolver{
		nodes:  make(map[string]*Node),
		byHash: make(map[meshcore.Hash][]string),
	}
}

// Upsert records or updates a node. It returns the stored node and whether
// anything actually changed, so callers can avoid pointless database writes.
func (r *Resolver) Upsert(n Node) (*Node, bool) {
	key := strings.ToUpper(n.Key)
	if key == "" {
		return nil, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	cur, exists := r.nodes[key]
	if !exists {
		cp := n
		cp.Key = key
		r.nodes[key] = &cp
		r.indexLocked(key)
		return &cp, true
	}

	changed := false
	if n.Name != "" && n.Name != cur.Name {
		cur.Name, changed = n.Name, true
	}
	if n.NodeType != 0 && n.NodeType != cur.NodeType {
		cur.NodeType, changed = n.NodeType, true
	}
	if n.PathHashSize != 0 && n.PathHashSize != cur.PathHashSize {
		cur.PathHashSize, changed = n.PathHashSize, true
	}
	// Not a change to persist: the database keeps its own last_seen.
	if n.LastHeard.After(cur.LastHeard) {
		cur.LastHeard = n.LastHeard
	}
	// A node that has reported a position keeps it until it reports another one:
	// adverts without the lat/lon flag must not erase a known location.
	if n.Latitude != nil && n.Longitude != nil {
		if cur.Latitude == nil || cur.Longitude == nil || *cur.Latitude != *n.Latitude || *cur.Longitude != *n.Longitude {
			cur.Latitude, cur.Longitude, changed = n.Latitude, n.Longitude, true
		}
	}
	return cur, changed
}

// indexLocked adds key under every hash width. Caller holds the write lock.
func (r *Resolver) indexLocked(key string) {
	raw := decodeHex(key)
	if len(raw) == 0 {
		return
	}
	for w := 1; w <= meshcore.MaxHashSize && w <= len(raw); w++ {
		h := meshcore.NewHash(raw[:w])
		for _, existing := range r.byHash[h] {
			if existing == key {
				return
			}
		}
		r.byHash[h] = append(r.byHash[h], key)
	}
}

// Resolve maps a path hash to a node.
func (r *Resolver) Resolve(h meshcore.Hash) Resolution {
	r.mu.RLock()
	defer r.mu.RUnlock()
	c := r.byHash[h]
	switch len(c) {
	case 0:
		return Resolution{}
	case 1:
		return Resolution{Key: c[0], Candidates: 1}
	default:
		return Resolution{Ambiguous: true, Candidates: len(c)}
	}
}

// Plausible reports whether nodes a and b can be one radio hop apart.
//
// A hash that matches a single known node is only unique among the nodes we
// have heard adverts from. When the real hop never advertised, the hash lands on
// whichever node shares it, possibly on another continent: every broker feeds
// the same resolver. Distance is the one check that does not depend on knowing
// every node. A pair with an unknown position passes, since it is not drawn.
func (r *Resolver) Plausible(a, b string) bool {
	if r.MaxHopKm <= 0 {
		return true
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	na, nb := r.nodes[a], r.nodes[b]
	if na == nil || nb == nil || !na.HasPosition() || !nb.HasPosition() {
		return true
	}
	return geo.HaversineKm(*na.Latitude, *na.Longitude, *nb.Latitude, *nb.Longitude) <= r.MaxHopKm
}

// Touch records that a known node was heard at `at`. Unknown keys are ignored:
// a node exists only once an advert has introduced it.
func (r *Resolver) Touch(key string, at time.Time) {
	if key == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if n := r.nodes[strings.ToUpper(key)]; n != nil && at.After(n.LastHeard) {
		n.LastHeard = at
	}
}

// Get returns a copy of a node by key.
func (r *Resolver) Get(key string) (Node, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	n, ok := r.nodes[strings.ToUpper(key)]
	if !ok {
		return Node{}, false
	}
	return *n, true
}

// Nodes returns every known node.
func (r *Resolver) Nodes() []Node {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Node, 0, len(r.nodes))
	for _, n := range r.nodes {
		out = append(out, *n)
	}
	return out
}

// Len is the number of known nodes.
func (r *Resolver) Len() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.nodes)
}

func decodeHex(s string) []byte {
	if len(s)%2 != 0 {
		return nil
	}
	out := make([]byte, len(s)/2)
	for i := 0; i < len(out); i++ {
		hi, ok1 := hexVal(s[i*2])
		lo, ok2 := hexVal(s[i*2+1])
		if !ok1 || !ok2 {
			return nil
		}
		out[i] = hi<<4 | lo
	}
	return out
}

func hexVal(c byte) (byte, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10, true
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10, true
	}
	return 0, false
}
