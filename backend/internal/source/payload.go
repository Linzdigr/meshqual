package source

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// flexFloat accepts a JSON number or a quoted number. The community observer
// bridges publish "SNR": "4" (a string) while others publish 4.0, so a strict
// float64 field silently drops half the fleet.
type flexFloat struct {
	Val   float64
	Valid bool
}

func (f *flexFloat) UnmarshalJSON(b []byte) error {
	s := strings.Trim(strings.TrimSpace(string(b)), `"`)
	if s == "" || s == "null" {
		return nil
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return nil // tolerate garbage in one field rather than drop the frame
	}
	f.Val, f.Valid = v, true
	return nil
}

func (f flexFloat) ptr() *float64 {
	if !f.Valid {
		return nil
	}
	v := f.Val
	return &v
}

func (f flexFloat) intPtr() *int {
	if !f.Valid {
		return nil
	}
	v := int(f.Val)
	return &v
}

// observerPayload is the union of the field spellings seen in the wild across
// the MeshCore observer bridges. Unknown fields are ignored.
type observerPayload struct {
	Type      string `json:"type"`
	Direction string `json:"direction"`

	Origin   string `json:"origin"`
	OriginID string `json:"origin_id"`

	// Several spellings of the same three values.
	SNRUpper  flexFloat `json:"SNR"`
	SNRLower  flexFloat `json:"snr"`
	RSSIUpper flexFloat `json:"RSSI"`
	RSSILower flexFloat `json:"rssi"`

	RawUpper string `json:"raw"`
	RawAlt   string `json:"raw_hex"`
	RawPkt   string `json:"packet"`
	RawPay   string `json:"payload"`

	Timestamp string `json:"timestamp"`
	Time      string `json:"time"`
}

func (p observerPayload) snr() *float64 {
	if v := p.SNRUpper.ptr(); v != nil {
		return v
	}
	return p.SNRLower.ptr()
}

func (p observerPayload) rssi() *int {
	if v := p.RSSIUpper.intPtr(); v != nil {
		return v
	}
	return p.RSSILower.intPtr()
}

func (p observerPayload) rawHex() string {
	for _, s := range []string{p.RawUpper, p.RawAlt, p.RawPkt, p.RawPay} {
		if s != "" {
			return s
		}
	}
	return ""
}

var errNotAPacket = fmt.Errorf("source: not a packet message")

// parseObservation turns one MQTT message into an Observation.
//
// Topic shape (meshcoretomqtt, comchan): meshcore/{REGION}/{PUBKEY}/{kind}
func parseObservation(sourceID, topic string, body []byte, now time.Time) (Observation, error) {
	region, observerKey, kind := splitTopic(topic)
	if kind != "" && kind != "packets" {
		return Observation{}, errNotAPacket
	}

	var p observerPayload
	if err := json.Unmarshal(body, &p); err != nil {
		return Observation{}, fmt.Errorf("source: bad json: %w", err)
	}
	if p.Type != "" && !strings.EqualFold(p.Type, "PACKET") {
		return Observation{}, errNotAPacket
	}

	rawHex := strings.TrimSpace(p.rawHex())
	if rawHex == "" {
		// Without the frame there is no path and therefore no link: the SNR
		// alone cannot be attributed to any pair of nodes.
		return Observation{}, fmt.Errorf("source: message carries no raw frame")
	}
	raw, err := hex.DecodeString(strings.TrimPrefix(rawHex, "0x"))
	if err != nil {
		return Observation{}, fmt.Errorf("source: bad raw hex: %w", err)
	}

	obs := Observation{
		SourceID:     sourceID,
		ObserverKey:  strings.ToUpper(firstNonEmpty(observerKey, p.OriginID)),
		ObserverName: p.Origin,
		Region:       strings.ToUpper(region),
		ReceivedAt:   parseTime(p.Timestamp, now),
		Direction:    strings.ToLower(firstNonEmpty(p.Direction, "rx")),
		SNR:          p.snr(),
		RSSI:         p.rssi(),
		Raw:          raw,
		Topic:        topic,
	}
	return obs, nil
}

func splitTopic(topic string) (region, pubkey, kind string) {
	parts := strings.Split(strings.Trim(topic, "/"), "/")
	// Tolerate a broker-side prefix before "meshcore".
	for i, s := range parts {
		if strings.EqualFold(s, "meshcore") {
			parts = parts[i:]
			break
		}
	}
	get := func(i int) string {
		if i < len(parts) {
			return parts[i]
		}
		return ""
	}
	return get(1), get(2), get(3)
}

// parseTime prefers the observer's own timestamp and falls back to arrival time.
// A clock-skewed observer must not be able to push samples into the future.
func parseTime(s string, now time.Time) time.Time {
	if s == "" {
		return now
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.999999", "2006-01-02 15:04:05"} {
		if t, err := time.Parse(layout, s); err == nil {
			if t.After(now.Add(2 * time.Minute)) {
				return now
			}
			return t.UTC()
		}
	}
	return now
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
