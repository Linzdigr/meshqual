package source

import (
	"testing"
	"time"
)

func TestParseObservationAcceptsStringAndNumericFields(t *testing.T) {
	now := time.Date(2026, 10, 2, 8, 0, 0, 0, time.UTC)
	topic := "meshcore/ANE/1512521F15BB5245/packets"

	// The community bridges publish numbers as strings; others publish real
	// numbers. Both must work or half the fleet is silently dropped.
	cases := map[string]string{
		"strings": `{"type":"PACKET","direction":"rx","origin":"obs1","SNR":"12.8","RSSI":"-20","raw":"1446ABCD","timestamp":"2026-10-02T07:59:00.123456"}`,
		"numbers": `{"type":"PACKET","direction":"rx","origin":"obs1","snr":12.8,"rssi":-20,"raw":"1446ABCD"}`,
	}
	for name, body := range cases {
		obs, err := parseObservation("s1", topic, []byte(body), now)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if obs.SNR == nil || *obs.SNR != 12.8 {
			t.Errorf("%s: SNR = %v, want 12.8", name, obs.SNR)
		}
		if obs.RSSI == nil || *obs.RSSI != -20 {
			t.Errorf("%s: RSSI = %v, want -20", name, obs.RSSI)
		}
		if obs.ObserverKey != "1512521F15BB5245" {
			t.Errorf("%s: observer = %q", name, obs.ObserverKey)
		}
		if obs.Region != "ANE" {
			t.Errorf("%s: region = %q", name, obs.Region)
		}
		if len(obs.Raw) != 4 {
			t.Errorf("%s: raw = %v", name, obs.Raw)
		}
	}
}

func TestParseObservationSkipsNonPacketTopics(t *testing.T) {
	now := time.Now().UTC()
	for _, topic := range []string{
		"meshcore/ANE/ABCD/status",
		"meshcore/ANE/ABCD/debug",
	} {
		if _, err := parseObservation("s1", topic, []byte(`{"type":"PACKET","raw":"1400"}`), now); err == nil {
			t.Errorf("%s: accepted, want skipped", topic)
		}
	}
}

func TestParseObservationRequiresRawFrame(t *testing.T) {
	// Without the frame there is no path, so the SNR cannot be attributed to a
	// pair of nodes. Such a message is useless, not merely incomplete.
	_, err := parseObservation("s1", "meshcore/ANE/AB/packets",
		[]byte(`{"type":"PACKET","SNR":"5","RSSI":"-90"}`), time.Now().UTC())
	if err == nil {
		t.Fatal("accepted a message with no raw frame")
	}
}

func TestParseTimeRejectsFutureClockSkew(t *testing.T) {
	now := time.Date(2026, 10, 2, 8, 0, 0, 0, time.UTC)
	// An observer with a badly set clock must not push samples into the future,
	// or it silently owns the "latest" state of every link it touches.
	got := parseTime("2027-01-01T00:00:00Z", now)
	if !got.Equal(now) {
		t.Errorf("future timestamp accepted: %v", got)
	}
	// A plausible past timestamp is kept.
	got = parseTime("2026-10-02T07:59:00Z", now)
	if got.Equal(now) {
		t.Error("valid timestamp was discarded")
	}
}

func TestSplitTopicTolerance(t *testing.T) {
	for _, tc := range []struct{ topic, region, key, kind string }{
		{"meshcore/ANE/ABCD/packets", "ANE", "ABCD", "packets"},
		{"/meshcore/PAR/1234/packets", "PAR", "1234", "packets"},
		{"bridge/meshcore/LON/EF01/packets", "LON", "EF01", "packets"},
	} {
		r, k, kind := splitTopic(tc.topic)
		if r != tc.region || k != tc.key || kind != tc.kind {
			t.Errorf("%s -> %q/%q/%q, want %q/%q/%q", tc.topic, r, k, kind, tc.region, tc.key, tc.kind)
		}
	}
}
