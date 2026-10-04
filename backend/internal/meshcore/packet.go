// Package meshcore decodes MeshCore LoRa packets off the wire.
//
// The wire format is taken from the firmware, not inferred:
//
//	Dispatcher.cpp / tryParsePacket():
//	  i = 0
//	  header      = raw[i++]
//	  if hasTransportCodes(): transport_codes[0] (2B LE), [1] (2B LE)
//	  path_len    = raw[i++]
//	  path        = raw[i : i + (path_len&63)*hashSize]
//	  payload     = rest
//
//	Packet.h:
//	  getRouteType()    = header & 0x03
//	  getPayloadType()  = (header >> 2) & 0x0F
//	  getPayloadVer()   = (header >> 6) & 0x03
//	  getPathHashSize() = (path_len >> 6) + 1
//	  getPathHashCount()= path_len & 63
//	  hasTransportCodes() = routeType is TRANSPORT_FLOOD or TRANSPORT_DIRECT
package meshcore

import (
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
)

// Route types (Packet.h).
const (
	RouteTransportFlood  uint8 = 0x00
	RouteFlood           uint8 = 0x01
	RouteDirect          uint8 = 0x02
	RouteTransportDirect uint8 = 0x03
)

// Payload types (Packet.h).
const (
	PayloadReq       uint8 = 0x00
	PayloadResponse  uint8 = 0x01
	PayloadTxtMsg    uint8 = 0x02
	PayloadAck       uint8 = 0x03
	PayloadAdvert    uint8 = 0x04
	PayloadGrpTxt    uint8 = 0x05
	PayloadGrpData   uint8 = 0x06
	PayloadAnonReq   uint8 = 0x07
	PayloadPath      uint8 = 0x08
	PayloadTrace     uint8 = 0x09
	PayloadMultipart uint8 = 0x0A
	PayloadControl   uint8 = 0x0B
	PayloadRawCustom uint8 = 0x0F
)

const (
	phRouteMask = 0x03
	phTypeShift = 2
	phTypeMask  = 0x0F
	phVerShift  = 6
	phVerMask   = 0x03

	// MaxPathSize mirrors MAX_PATH_SIZE in the firmware.
	MaxPathSize = 64
	// MaxHashSize is the widest path hash the format allows ((path_len>>6)+1).
	MaxHashSize = 4
)

var (
	ErrTooShort   = errors.New("meshcore: buffer too short")
	ErrPathTooBig = errors.New("meshcore: path exceeds MAX_PATH_SIZE")
)

var routeNames = map[uint8]string{
	RouteTransportFlood:  "TRANSPORT_FLOOD",
	RouteFlood:           "FLOOD",
	RouteDirect:          "DIRECT",
	RouteTransportDirect: "TRANSPORT_DIRECT",
}

var payloadNames = map[uint8]string{
	PayloadReq: "REQ", PayloadResponse: "RESPONSE", PayloadTxtMsg: "TXT_MSG",
	PayloadAck: "ACK", PayloadAdvert: "ADVERT", PayloadGrpTxt: "GRP_TXT",
	PayloadGrpData: "GRP_DATA", PayloadAnonReq: "ANON_REQ", PayloadPath: "PATH",
	PayloadTrace: "TRACE", PayloadMultipart: "MULTIPART", PayloadControl: "CONTROL",
	PayloadRawCustom: "RAW_CUSTOM",
}

// RouteName returns the firmware name of a route type.
func RouteName(rt uint8) string {
	if n, ok := routeNames[rt]; ok {
		return n
	}
	return fmt.Sprintf("ROUTE_%d", rt)
}

// PayloadName returns the firmware name of a payload type.
func PayloadName(pt uint8) string {
	if n, ok := payloadNames[pt]; ok {
		return n
	}
	return fmt.Sprintf("PAYLOAD_%#02x", pt)
}

// Hash is a path hash: a prefix of a node public key, 1 to 4 bytes wide.
// It is comparable so it can be used directly as a map key.
type Hash struct {
	b    [MaxHashSize]byte
	size uint8
}

// NewHash builds a Hash from up to MaxHashSize bytes.
func NewHash(b []byte) Hash {
	var h Hash
	n := len(b)
	if n > MaxHashSize {
		n = MaxHashSize
	}
	copy(h.b[:], b[:n])
	h.size = uint8(n)
	return h
}

// ParseHash builds a Hash from an uppercase hex prefix such as "030D".
func ParseHash(s string) (Hash, error) {
	b, err := hex.DecodeString(s)
	if err != nil {
		return Hash{}, err
	}
	if len(b) == 0 || len(b) > MaxHashSize {
		return Hash{}, fmt.Errorf("meshcore: hash %q must be 1..%d bytes", s, MaxHashSize)
	}
	return NewHash(b), nil
}

func (h Hash) Size() int     { return int(h.size) }
func (h Hash) Bytes() []byte { return h.b[:h.size] }
func (h Hash) IsZero() bool  { return h.size == 0 }

// String renders the hash as uppercase hex, e.g. "030D".
func (h Hash) String() string {
	dst := make([]byte, h.size*2)
	hex.Encode(dst, h.b[:h.size])
	return upper(dst)
}

func upper(b []byte) string {
	for i, c := range b {
		if c >= 'a' && c <= 'f' {
			b[i] = c - 32
		}
	}
	return string(b)
}

// Packet is a decoded MeshCore packet.
type Packet struct {
	Header         uint8
	TransportCodes [2]uint16
	PathLenByte    uint8
	Path           []byte // raw path bytes: hop hashes, or per-hop SNR for TRACE
	Payload        []byte
}

func (p *Packet) RouteType() uint8   { return p.Header & phRouteMask }
func (p *Packet) PayloadType() uint8 { return (p.Header >> phTypeShift) & phTypeMask }
func (p *Packet) PayloadVer() uint8  { return (p.Header >> phVerShift) & phVerMask }

// HasTransportCodes mirrors Packet::hasTransportCodes().
func (p *Packet) HasTransportCodes() bool {
	rt := p.RouteType()
	return rt == RouteTransportFlood || rt == RouteTransportDirect
}

// HashSize mirrors Packet::getPathHashSize(): (path_len >> 6) + 1.
func (p *Packet) HashSize() int { return int(p.PathLenByte>>6) + 1 }

// IsFlood reports a flood-routed packet. Only those carry the originator's path
// hash width: a zero-hop packet is sent DIRECT with path_len 0, which reads as
// a 1-byte width whatever the sender is configured for (Mesh::sendZeroHop).
func (p *Packet) IsFlood() bool {
	rt := p.RouteType()
	return rt == RouteFlood || rt == RouteTransportFlood
}

// HopCount mirrors Packet::getPathHashCount(): path_len & 63.
func (p *Packet) HopCount() int { return int(p.PathLenByte & 63) }

// IsTrace reports whether this is a TRACE packet, where Path holds per-hop SNR
// bytes rather than hop hashes (Mesh.cpp: "append SNR (Not hash!)").
func (p *Packet) IsTrace() bool {
	return p.RouteType() == RouteDirect && p.PayloadType() == PayloadTrace
}

// Hops splits Path into hop hashes. It returns nil for TRACE packets, whose Path
// carries SNR samples instead; use DecodeTrace for those.
func (p *Packet) Hops() []Hash {
	if p.IsTrace() {
		return nil
	}
	hs := p.HashSize()
	n := len(p.Path) / hs
	if n == 0 {
		return nil
	}
	out := make([]Hash, n)
	for i := range out {
		out[i] = NewHash(p.Path[i*hs : (i+1)*hs])
	}
	return out
}

// Decode parses a raw radio frame.
func Decode(raw []byte) (*Packet, error) {
	if len(raw) < 2 {
		return nil, ErrTooShort
	}
	p := &Packet{Header: raw[0]}
	i := 1
	if p.HasTransportCodes() {
		if len(raw) < i+4 {
			return nil, fmt.Errorf("%w: transport codes", ErrTooShort)
		}
		p.TransportCodes[0] = binary.LittleEndian.Uint16(raw[i:])
		p.TransportCodes[1] = binary.LittleEndian.Uint16(raw[i+2:])
		i += 4
	}
	if len(raw) <= i {
		return nil, fmt.Errorf("%w: path_len", ErrTooShort)
	}
	p.PathLenByte = raw[i]
	i++

	pathBytes := p.HopCount() * p.HashSize()
	if pathBytes > MaxPathSize {
		return nil, fmt.Errorf("%w: %d bytes", ErrPathTooBig, pathBytes)
	}
	if len(raw) < i+pathBytes {
		return nil, fmt.Errorf("%w: path (need %d, have %d)", ErrTooShort, pathBytes, len(raw)-i)
	}
	p.Path = append([]byte(nil), raw[i:i+pathBytes]...)
	i += pathBytes
	p.Payload = append([]byte(nil), raw[i:]...)
	return p, nil
}
