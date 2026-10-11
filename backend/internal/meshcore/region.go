package meshcore

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"strings"
)

// RegionKey is the transport key of a public ("hashtag") region: the first 16
// bytes of SHA-256 over its name with a leading '#' (TransportKeyStore::
// getAutoKeyFor; RegionMap gives plain names an implicit '#'). Private regions
// ('$' names) have secret keys and cannot be recognised.
func RegionKey(name string) [16]byte {
	if !strings.HasPrefix(name, "#") {
		name = "#" + name
	}
	sum := sha256.Sum256([]byte(name))
	var k [16]byte
	copy(k[:], sum[:16])
	return k
}

// TransportCode is the code a node scoped to the region of key puts in a
// packet (TransportKey::calcTransportCode): HMAC-SHA256 over the payload type
// and the payload, first two bytes little-endian, 0000 and FFFF reserved.
func TransportCode(key [16]byte, payloadType uint8, payload []byte) uint16 {
	m := hmac.New(sha256.New, key[:])
	m.Write([]byte{payloadType})
	m.Write(payload)
	code := binary.LittleEndian.Uint16(m.Sum(nil)[:2])
	switch code {
	case 0:
		code = 1
	case 0xFFFF:
		code = 0xFFFE
	}
	return code
}

// RegionBook names the region of a scoped packet by trying candidate names:
// the code is keyed, so only a known name can be recognised.
type RegionBook struct {
	names []string
	keys  [][16]byte
}

// NewRegionBook prepares the candidates. Names are tried exactly as given;
// the firmware compares them byte for byte.
func NewRegionBook(names []string) *RegionBook {
	b := &RegionBook{}
	seen := map[string]bool{}
	for _, n := range names {
		n = strings.TrimPrefix(strings.TrimSpace(n), "#")
		if n == "" || seen[n] {
			continue
		}
		seen[n] = true
		b.names = append(b.names, n)
		b.keys = append(b.keys, RegionKey(n))
	}
	return b
}

// Match returns the region name of a TRANSPORT_FLOOD packet, or "" when it is
// not scoped or no candidate fits.
func (b *RegionBook) Match(p *Packet) string {
	if b == nil || p.RouteType() != RouteTransportFlood {
		return ""
	}
	for i, k := range b.keys {
		if TransportCode(k, p.PayloadType(), p.Payload) == p.TransportCodes[0] {
			return b.names[i]
		}
	}
	return ""
}

// Len is how many candidate names the book holds.
func (b *RegionBook) Len() int { return len(b.names) }
