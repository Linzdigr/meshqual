package meshcore

import (
	"encoding/hex"
	"testing"
)

// Vector from an independent HMAC-SHA256 (Python hmac/hashlib) over the
// firmware's inputs: key = SHA-256("#bzh")[:16], message = type || payload.
func TestTransportCodeMatchesReference(t *testing.T) {
	key := RegionKey("bzh")
	if got := hex.EncodeToString(key[:]); got != "7340d945ec5679119cd6860f1afd13f1" {
		t.Fatalf("key = %s", got)
	}
	if RegionKey("#bzh") != key {
		t.Error("a leading # must not change the key")
	}
	payload := make([]byte, 40)
	for i := range payload {
		payload[i] = byte(i)
	}
	if got := TransportCode(key, PayloadAdvert, payload); got != 38244 {
		t.Errorf("code = %d, want 38244", got)
	}
}

func TestRegionBookNamesScopedPackets(t *testing.T) {
	payload := []byte("an advert payload")
	key := RegionKey("fr-35")
	p := &Packet{
		Header:         RouteTransportFlood | PayloadAdvert<<phTypeShift,
		TransportCodes: [2]uint16{TransportCode(key, PayloadAdvert, payload), 0},
		Payload:        payload,
	}
	book := NewRegionBook([]string{"fr", "#fr-35", "bzh"})
	if got := book.Match(p); got != "fr-35" {
		t.Errorf("match = %q, want fr-35", got)
	}
	if got := NewRegionBook([]string{"fr", "bzh"}).Match(p); got != "" {
		t.Errorf("match = %q, want none: the name is not a candidate", got)
	}
	p.Header = RouteFlood | PayloadAdvert<<phTypeShift
	if got := book.Match(p); got != "" {
		t.Errorf("an unscoped packet matched %q", got)
	}
}
