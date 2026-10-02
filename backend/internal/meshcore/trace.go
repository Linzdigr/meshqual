package meshcore

import (
	"encoding/binary"
	"fmt"
)

// traceHeaderLen is tag(4) + auth_code(4) + flags(1), per Mesh.cpp.
const traceHeaderLen = 9

// TraceHop is one hop of a TRACE route. SNR is non-nil only for hops the packet
// has actually traversed.
type TraceHop struct {
	Hash Hash     `json:"hash"`
	SNR  *float64 `json:"snr"`
}

// Trace is a decoded PAYLOAD_TYPE_TRACE packet.
//
// Mesh.cpp, onRecvPacket():
//
//	memcpy(&trace_tag, &pkt->payload[i], 4); i += 4;
//	memcpy(&auth_code, &pkt->payload[i], 4); i += 4;
//	uint8_t flags = pkt->payload[i++];
//	uint8_t path_sz = flags & 0x03;          // hash size = 1 << path_sz
//	...
//	// append SNR (Not hash!)
//	pkt->path[pkt->path_len++] = (int8_t) (pkt->getSNR()*4);
//
// So the declared route lives in the payload as fixed-width hashes, while the
// packet's own path array accumulates one signed SNR byte per traversed hop.
// Path[i] is therefore the SNR that hop i measured on the link from hop i-1.
type Trace struct {
	Tag      uint32     `json:"tag"`
	AuthCode uint32     `json:"authCode"`
	Flags    uint8      `json:"flags"`
	HashSize int        `json:"hashSize"`
	Hops     []TraceHop `json:"hops"`
	// Truncated is set when the payload length is not a whole number of hashes.
	Truncated bool `json:"truncated"`
}

// DecodeTrace decodes a TRACE packet's route and its per-hop SNR samples.
func (p *Packet) DecodeTrace() (*Trace, error) {
	if !p.IsTrace() {
		return nil, fmt.Errorf("meshcore: not a TRACE packet (route=%s type=%s)",
			RouteName(p.RouteType()), PayloadName(p.PayloadType()))
	}
	if len(p.Payload) < traceHeaderLen {
		return nil, fmt.Errorf("%w: trace header", ErrTooShort)
	}
	t := &Trace{
		Tag:      binary.LittleEndian.Uint32(p.Payload[0:4]),
		AuthCode: binary.LittleEndian.Uint32(p.Payload[4:8]),
		Flags:    p.Payload[8],
	}
	t.HashSize = 1 << (t.Flags & 0x03)

	rest := p.Payload[traceHeaderLen:]
	n := len(rest) / t.HashSize
	t.Truncated = len(rest)%t.HashSize != 0

	t.Hops = make([]TraceHop, n)
	for i := 0; i < n; i++ {
		t.Hops[i].Hash = NewHash(rest[i*t.HashSize : (i+1)*t.HashSize])
		// Path holds one SNR byte per hop already traversed. Guard on the real
		// slice length rather than HopCount(): a TRACE sets the hash-size bits
		// to zero, but a malformed sender could not be trusted to.
		if i < len(p.Path) {
			v := float64(int8(p.Path[i])) / 4
			t.Hops[i].SNR = &v
		}
	}
	return t, nil
}

// TraceSNRCount is the number of hops that have reported an SNR sample.
func (t *Trace) TraceSNRCount() int {
	n := 0
	for _, h := range t.Hops {
		if h.SNR != nil {
			n++
		}
	}
	return n
}
