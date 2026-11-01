package ingest

import (
	"testing"
	"time"

	"github.com/yvanferez/meshqual/backend/internal/source"
)

func TestObsDedupDropsSecondDelivery(t *testing.T) {
	d := NewObsDedup(time.Minute)
	now := time.Now()
	o := source.Observation{ObserverKey: "OBS", Direction: "rx", Raw: []byte{0x11, 0x02, 0xAA, 0xBB}, SourceID: "local"}
	if !d.First(o, now) {
		t.Fatal("first delivery dropped")
	}
	again := o
	again.SourceID = "bridge" // same reception, another way in
	if d.First(again, now.Add(time.Millisecond)) {
		t.Error("second delivery of the same reception kept")
	}

	other := o
	other.Raw = []byte{0x11, 0x02, 0xAA, 0xCC} // same packet heard via another repeater
	if !d.First(other, now) {
		t.Error("a reception with another path was dropped")
	}
	tx := o
	tx.Direction = "tx"
	if !d.First(tx, now) {
		t.Error("the observer's own retransmission was dropped")
	}
	elsewhere := o
	elsewhere.ObserverKey = "OBS2"
	if !d.First(elsewhere, now) {
		t.Error("another observer's reception was dropped")
	}
	if !d.First(o, now.Add(2*time.Minute)) {
		t.Error("a delivery past the window was dropped")
	}
}
