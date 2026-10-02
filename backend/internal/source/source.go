// Package source abstracts where raw MeshCore observations come from.
//
// Two implementations ship today, both MQTT but with different brokers and
// credentials: the public community broker and a self-hosted one. The interface
// exists so a third (a serial-attached observer, a file replay for tests) drops
// in without touching the ingest pipeline.
package source

import (
	"context"
	"time"
)

// Observation is one reception of one frame by one observer. It is the only
// thing the ingest pipeline consumes, whatever the transport underneath.
type Observation struct {
	// SourceID identifies the configured source that produced this, so a frame
	// seen via two brokers can be de-duplicated and attributed.
	SourceID string

	ObserverKey  string // full public key, uppercase hex; may be empty
	ObserverName string
	Region       string // IATA-ish region tag from the topic

	ReceivedAt time.Time
	Direction  string // "rx" or "tx"

	SNR  *float64 // observer's own radio: the LAST hop only
	RSSI *int

	Raw []byte // the full radio frame

	Topic string
}

// Source produces Observations until ctx is cancelled. Run must not return until
// it has stopped writing to out.
type Source interface {
	ID() string
	Run(ctx context.Context, out chan<- Observation) error
}

// Stats is what a source reports for /api/health.
type Stats struct {
	ID        string     `json:"id"`
	Kind      string     `json:"kind"`
	Connected bool       `json:"connected"`
	Received  uint64     `json:"received"`
	Dropped   uint64     `json:"dropped"`
	DecodeErr uint64     `json:"decodeErrors"`
	LastMsgAt *time.Time `json:"lastMessageAt"`
	LastError string     `json:"lastError,omitempty"`
}

// Reporter is implemented by sources that expose health.
type Reporter interface{ Stats() Stats }
