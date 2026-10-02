package meshcore

import (
	"encoding/binary"
	"encoding/hex"
	"math"
	"strings"
	"testing"
)

// header builds a header byte the way the firmware does: 0bVVPPPPRR.
func header(route, payload, ver uint8) uint8 {
	return (route & phRouteMask) | ((payload & phTypeMask) << phTypeShift) | ((ver & phVerMask) << phVerShift)
}

// pathLen builds the path_len byte: hop count in bits 0-5, hashSize-1 in bits 6-7.
func pathLen(hops int, hashSize int) uint8 {
	return uint8(hops&63) | uint8((hashSize-1)&0x03)<<6
}

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("bad hex %q: %v", s, err)
	}
	return b
}

func TestHeaderBitfields(t *testing.T) {
	// GRP_TXT over TRANSPORT_FLOOD, payload version 0 -> 0x14.
	h := header(RouteTransportFlood, PayloadGrpTxt, 0)
	if h != 0x14 {
		t.Fatalf("header = %#02x, want 0x14", h)
	}
	p := &Packet{Header: h}
	if got := p.RouteType(); got != RouteTransportFlood {
		t.Errorf("RouteType = %d, want %d", got, RouteTransportFlood)
	}
	if got := p.PayloadType(); got != PayloadGrpTxt {
		t.Errorf("PayloadType = %d, want %d", got, PayloadGrpTxt)
	}
	if got := p.PayloadVer(); got != 0 {
		t.Errorf("PayloadVer = %d, want 0", got)
	}
	if !p.HasTransportCodes() {
		t.Error("TRANSPORT_FLOOD must carry transport codes")
	}

	// Payload version must not bleed into the payload type.
	p2 := &Packet{Header: header(RouteDirect, PayloadRawCustom, 3)}
	if p2.PayloadType() != PayloadRawCustom || p2.PayloadVer() != 3 || p2.RouteType() != RouteDirect {
		t.Errorf("bitfields collide: type=%#02x ver=%d route=%d",
			p2.PayloadType(), p2.PayloadVer(), p2.RouteType())
	}
	if p2.HasTransportCodes() {
		t.Error("DIRECT must not carry transport codes")
	}
}

func TestPathLenBitfields(t *testing.T) {
	for _, tc := range []struct{ hops, size int }{{0, 1}, {6, 2}, {63, 4}, {1, 3}} {
		p := &Packet{PathLenByte: pathLen(tc.hops, tc.size)}
		if got := p.HopCount(); got != tc.hops {
			t.Errorf("hops=%d size=%d: HopCount = %d", tc.hops, tc.size, got)
		}
		if got := p.HashSize(); got != tc.size {
			t.Errorf("hops=%d size=%d: HashSize = %d", tc.hops, tc.size, got)
		}
	}
}

// TestDecodeTransportFlood rebuilds a frame matching a real observation: a
// GRP_TXT flood with a six-hop, 2-byte-hash path and transport codes set.
func TestDecodeTransportFlood(t *testing.T) {
	hops := []string{"030D", "2BDA", "95B5", "5273", "19E2", "C13A"}

	var raw []byte
	raw = append(raw, header(RouteTransportFlood, PayloadGrpTxt, 0))
	raw = binary.LittleEndian.AppendUint16(raw, 36156)
	raw = binary.LittleEndian.AppendUint16(raw, 0)
	raw = append(raw, pathLen(len(hops), 2))
	for _, h := range hops {
		raw = append(raw, mustHex(t, h)...)
	}
	payload := []byte("hello mesh")
	raw = append(raw, payload...)

	p, err := Decode(raw)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if p.TransportCodes[0] != 36156 || p.TransportCodes[1] != 0 {
		t.Errorf("TransportCodes = %v, want [36156 0]", p.TransportCodes)
	}
	if p.HopCount() != 6 || p.HashSize() != 2 {
		t.Errorf("HopCount=%d HashSize=%d, want 6 and 2", p.HopCount(), p.HashSize())
	}
	got := make([]string, 0, 6)
	for _, h := range p.Hops() {
		got = append(got, h.String())
	}
	if strings.Join(got, ",") != strings.Join(hops, ",") {
		t.Errorf("Hops = %v, want %v", got, hops)
	}
	if string(p.Payload) != string(payload) {
		t.Errorf("Payload = %q, want %q", p.Payload, payload)
	}
}

func TestDecodeFloodNoTransportCodes(t *testing.T) {
	// A plain FLOOD has no transport codes: path_len sits at byte 1.
	raw := []byte{header(RouteFlood, PayloadAdvert, 0), pathLen(1, 1), 0xAB, 0xFF}
	p, err := Decode(raw)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if p.TransportCodes != [2]uint16{0, 0} {
		t.Errorf("TransportCodes = %v, want zero", p.TransportCodes)
	}
	if h := p.Hops(); len(h) != 1 || h[0].String() != "AB" {
		t.Errorf("Hops = %v, want [AB]", h)
	}
	if len(p.Payload) != 1 || p.Payload[0] != 0xFF {
		t.Errorf("Payload = %v, want [255]", p.Payload)
	}
}

func TestDecodeZeroHopPath(t *testing.T) {
	// Heard straight from the originator: no hops at all.
	raw := []byte{header(RouteFlood, PayloadTxtMsg, 0), pathLen(0, 1), 1, 2, 3}
	p, err := Decode(raw)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if len(p.Hops()) != 0 {
		t.Errorf("Hops = %v, want empty", p.Hops())
	}
	if len(p.Payload) != 3 {
		t.Errorf("Payload len = %d, want 3", len(p.Payload))
	}
}

func TestDecodeTruncated(t *testing.T) {
	cases := map[string][]byte{
		"empty":            {},
		"header only":      {header(RouteFlood, PayloadAck, 0)},
		"transport cut":    {header(RouteTransportFlood, PayloadAck, 0), 0x01, 0x02},
		"path_len missing": {header(RouteTransportFlood, PayloadAck, 0), 1, 2, 3, 4},
		"path cut":         {header(RouteFlood, PayloadAck, 0), pathLen(4, 2), 0xAA},
	}
	for name, raw := range cases {
		if _, err := Decode(raw); err == nil {
			t.Errorf("%s: Decode succeeded, want error", name)
		}
	}
}

func TestDecodeRejectsOversizePath(t *testing.T) {
	// 63 hops of 4 bytes = 252 > MAX_PATH_SIZE; must be refused, not read.
	raw := append([]byte{header(RouteFlood, PayloadAck, 0), pathLen(63, 4)}, make([]byte, 300)...)
	if _, err := Decode(raw); err == nil {
		t.Fatal("oversize path accepted")
	}
}

func TestDecodeTrace(t *testing.T) {
	// Route DIRECT + PAYLOAD_TYPE_TRACE. Payload: tag, auth, flags, then the
	// declared route. Path accumulates one SNR byte per traversed hop.
	route := []string{"030D", "2BDA", "95B5"}
	snrs := []float64{12.75, -4.25} // only the first two hops have forwarded

	var raw []byte
	raw = append(raw, header(RouteDirect, PayloadTrace, 0))
	raw = append(raw, pathLen(len(snrs), 1))
	for _, s := range snrs {
		raw = append(raw, byte(int8(s*4)))
	}
	raw = binary.LittleEndian.AppendUint32(raw, 0xDEADBEEF)
	raw = binary.LittleEndian.AppendUint32(raw, 0x12345678)
	raw = append(raw, 0x01) // flags: path_sz = 1 -> hash size 2
	for _, h := range route {
		raw = append(raw, mustHex(t, h)...)
	}

	p, err := Decode(raw)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if !p.IsTrace() {
		t.Fatal("IsTrace = false")
	}
	if p.Hops() != nil {
		t.Error("Hops must be nil for TRACE: the path holds SNR, not hashes")
	}
	tr, err := p.DecodeTrace()
	if err != nil {
		t.Fatalf("DecodeTrace: %v", err)
	}
	if tr.Tag != 0xDEADBEEF || tr.AuthCode != 0x12345678 {
		t.Errorf("tag=%#x auth=%#x", tr.Tag, tr.AuthCode)
	}
	if tr.HashSize != 2 {
		t.Errorf("HashSize = %d, want 2", tr.HashSize)
	}
	if tr.Truncated {
		t.Error("Truncated set on a well-formed trace")
	}
	if len(tr.Hops) != 3 {
		t.Fatalf("Hops = %d, want 3", len(tr.Hops))
	}
	for i, want := range route {
		if tr.Hops[i].Hash.String() != want {
			t.Errorf("hop %d = %s, want %s", i, tr.Hops[i].Hash, want)
		}
	}
	for i, want := range snrs {
		if tr.Hops[i].SNR == nil {
			t.Fatalf("hop %d SNR is nil", i)
		}
		if math.Abs(*tr.Hops[i].SNR-want) > 1e-9 {
			t.Errorf("hop %d SNR = %v, want %v", i, *tr.Hops[i].SNR, want)
		}
	}
	if tr.Hops[2].SNR != nil {
		t.Error("hop 2 has not forwarded yet; SNR must stay nil")
	}
	if tr.TraceSNRCount() != 2 {
		t.Errorf("TraceSNRCount = %d, want 2", tr.TraceSNRCount())
	}
}

func TestDecodeTraceNegativeSNRRoundTrip(t *testing.T) {
	// SNR is stored as int8(snr*4): the sign must survive and the quantum is 0.25 dB.
	for _, want := range []float64{-20, -7.25, -0.25, 0, 0.5, 31.75} {
		b := byte(int8(want * 4))
		got := float64(int8(b)) / 4
		if math.Abs(got-want) > 1e-9 {
			t.Errorf("snr %v round-tripped to %v", want, got)
		}
	}
}

func TestDecodeAdvert(t *testing.T) {
	pub := make([]byte, PubKeySize)
	for i := range pub {
		pub[i] = byte(i + 1)
	}
	var payload []byte
	payload = append(payload, pub...)
	payload = binary.LittleEndian.AppendUint32(payload, 1789825821)
	payload = append(payload, make([]byte, SignatureSize)...)
	// appdata: repeater + lat/lon + name
	payload = append(payload, AdvTypeRepeater|advLatLonMask|advNameMask)
	payload = binary.LittleEndian.AppendUint32(payload, uint32(int32(48000550)))
	lonRaw := int32(-2253870)
	payload = binary.LittleEndian.AppendUint32(payload, uint32(lonRaw))
	payload = append(payload, []byte("fr35_Rpt-Broceliande")...)

	raw := append([]byte{header(RouteFlood, PayloadAdvert, 0), pathLen(0, 1)}, payload...)
	p, err := Decode(raw)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	a, err := p.DecodeAdvert()
	if err != nil {
		t.Fatalf("DecodeAdvert: %v", err)
	}
	if a.NodeType != AdvTypeRepeater {
		t.Errorf("NodeType = %d, want repeater", a.NodeType)
	}
	if a.Name != "fr35_Rpt-Broceliande" {
		t.Errorf("Name = %q", a.Name)
	}
	if a.Latitude == nil || math.Abs(*a.Latitude-48.00055) > 1e-9 {
		t.Errorf("Latitude = %v, want 48.00055", a.Latitude)
	}
	if a.Longitude == nil || math.Abs(*a.Longitude-(-2.25387)) > 1e-9 {
		t.Errorf("Longitude = %v, want -2.25387 (negative lon must survive)", a.Longitude)
	}
	if a.Timestamp != 1789825821 {
		t.Errorf("Timestamp = %d", a.Timestamp)
	}
	if got := a.Hash(2).String(); got != "0102" {
		t.Errorf("Hash(2) = %s, want 0102", got)
	}
	if !strings.HasPrefix(a.PublicKeyHex(), "0102030405") {
		t.Errorf("PublicKeyHex = %s", a.PublicKeyHex())
	}
}

func TestDecodeAdvertUnsetPositionIsNotZeroZero(t *testing.T) {
	pub := make([]byte, PubKeySize)
	var payload []byte
	payload = append(payload, pub...)
	payload = binary.LittleEndian.AppendUint32(payload, 1)
	payload = append(payload, make([]byte, SignatureSize)...)
	payload = append(payload, AdvTypeChat|advLatLonMask)
	payload = binary.LittleEndian.AppendUint32(payload, 0)
	payload = binary.LittleEndian.AppendUint32(payload, 0)

	raw := append([]byte{header(RouteFlood, PayloadAdvert, 0), pathLen(0, 1)}, payload...)
	p, err := Decode(raw)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	a, err := p.DecodeAdvert()
	if err != nil {
		t.Fatalf("DecodeAdvert: %v", err)
	}
	if a.Latitude != nil || a.Longitude != nil {
		t.Errorf("0,0 must decode as no position, got %v,%v", a.Latitude, a.Longitude)
	}
}

func TestHashRoundTrip(t *testing.T) {
	h, err := ParseHash("030d")
	if err != nil {
		t.Fatalf("ParseHash: %v", err)
	}
	if h.String() != "030D" {
		t.Errorf("String = %s, want 030D (uppercase)", h.String())
	}
	if h.Size() != 2 {
		t.Errorf("Size = %d, want 2", h.Size())
	}
	// Same bytes, different widths must not collide as map keys.
	m := map[Hash]int{NewHash([]byte{0x03}): 1, NewHash([]byte{0x03, 0x0D}): 2}
	if len(m) != 2 {
		t.Errorf("1-byte and 2-byte hashes collided: %v", m)
	}
	if _, err := ParseHash("0102030405"); err == nil {
		t.Error("5-byte hash accepted")
	}
}
