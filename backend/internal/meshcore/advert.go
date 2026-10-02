package meshcore

import (
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"strings"
	"unicode/utf8"
)

// Identity sizes (Identity.h / Ed25519).
const (
	PubKeySize    = 32
	SignatureSize = 64
)

// Advert node types (AdvertDataHelpers.h).
const (
	AdvTypeNone     uint8 = 0
	AdvTypeChat     uint8 = 1
	AdvTypeRepeater uint8 = 2
	AdvTypeRoom     uint8 = 3
	AdvTypeSensor   uint8 = 4
)

// Advert appdata flag masks (AdvertDataHelpers.h).
const (
	advTypeMask   = 0x0F
	advLatLonMask = 0x10
	advFeat1Mask  = 0x20
	advFeat2Mask  = 0x40
	advNameMask   = 0x80
)

var advTypeNames = map[uint8]string{
	AdvTypeNone: "none", AdvTypeChat: "companion", AdvTypeRepeater: "repeater",
	AdvTypeRoom: "room", AdvTypeSensor: "sensor",
}

// AdvTypeName returns a stable slug for an advert node type.
func AdvTypeName(t uint8) string {
	if n, ok := advTypeNames[t]; ok {
		return n
	}
	return fmt.Sprintf("type%d", t)
}

// Advert is a decoded PAYLOAD_TYPE_ADVERT payload. This is the only passive
// source of node identity and position, so it is what seeds the node table.
//
// Payload layout: pub_key(32) | timestamp(4 LE) | signature(64) | appdata
// Appdata (AdvertDataHelpers.cpp): flags(1) | [lat int32 LE] | [lon int32 LE] |
// [feat1 uint16 LE] | [feat2 uint16 LE] | [name], each gated by its flag mask.
// Lat/lon are scaled by 1e6.
type Advert struct {
	PublicKey []byte   `json:"publicKey"`
	Timestamp uint32   `json:"timestamp"`
	Signature []byte   `json:"-"`
	NodeType  uint8    `json:"nodeType"`
	Latitude  *float64 `json:"latitude"`
	Longitude *float64 `json:"longitude"`
	Feat1     *uint16  `json:"feat1"`
	Feat2     *uint16  `json:"feat2"`
	Name      string   `json:"name"`
}

// PublicKeyHex renders the full public key as uppercase hex.
func (a *Advert) PublicKeyHex() string {
	return strings.ToUpper(hex.EncodeToString(a.PublicKey))
}

// Hash returns the n-byte path hash this node answers to.
func (a *Advert) Hash(n int) Hash { return NewHash(a.PublicKey[:min(n, len(a.PublicKey))]) }

// DecodeAdvert decodes an ADVERT payload.
//
// The signature is carried but not verified here: verification needs Ed25519 over
// the exact signed region, which belongs in a separate step so an unverified
// advert can still be stored and flagged rather than silently dropped.
func (p *Packet) DecodeAdvert() (*Advert, error) {
	if p.PayloadType() != PayloadAdvert {
		return nil, fmt.Errorf("meshcore: not an ADVERT (type=%s)", PayloadName(p.PayloadType()))
	}
	const fixed = PubKeySize + 4 + SignatureSize
	if len(p.Payload) < fixed {
		return nil, fmt.Errorf("%w: advert fixed part (need %d, have %d)", ErrTooShort, fixed, len(p.Payload))
	}
	a := &Advert{
		PublicKey: append([]byte(nil), p.Payload[:PubKeySize]...),
		Timestamp: binary.LittleEndian.Uint32(p.Payload[PubKeySize : PubKeySize+4]),
		Signature: append([]byte(nil), p.Payload[PubKeySize+4:fixed]...),
	}

	app := p.Payload[fixed:]
	if len(app) == 0 {
		return a, nil
	}
	flags := app[0]
	a.NodeType = flags & advTypeMask
	i := 1

	need := func(n int) bool { return len(app) >= i+n }

	if flags&advLatLonMask != 0 {
		if !need(8) {
			return a, nil
		}
		lat := float64(int32(binary.LittleEndian.Uint32(app[i:]))) / 1e6
		lon := float64(int32(binary.LittleEndian.Uint32(app[i+4:]))) / 1e6
		i += 8
		// 0,0 is the firmware's "unset" value, not a position in the Gulf of Guinea.
		if lat != 0 || lon != 0 {
			a.Latitude, a.Longitude = &lat, &lon
		}
	}
	if flags&advFeat1Mask != 0 {
		if !need(2) {
			return a, nil
		}
		v := binary.LittleEndian.Uint16(app[i:])
		a.Feat1 = &v
		i += 2
	}
	if flags&advFeat2Mask != 0 {
		if !need(2) {
			return a, nil
		}
		v := binary.LittleEndian.Uint16(app[i:])
		a.Feat2 = &v
		i += 2
	}
	if flags&advNameMask != 0 && i < len(app) {
		raw := app[i:]
		if idx := indexByte(raw, 0); idx >= 0 {
			raw = raw[:idx]
		}
		if utf8.Valid(raw) {
			a.Name = string(raw)
		} else {
			a.Name = strings.ToValidUTF8(string(raw), "")
		}
	}
	return a, nil
}

func indexByte(b []byte, c byte) int {
	for i, x := range b {
		if x == c {
			return i
		}
	}
	return -1
}
