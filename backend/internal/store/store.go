// Package store persists observations, link samples and nodes in TimescaleDB.
//
// The live map is NOT served from here: that comes from the in-memory aggregator,
// because a bbox query against a hypertable every few seconds is the one thing
// that would make this expensive. Postgres owns durability, history and the
// per-link time series.
package store

import (
	"context"
	"time"

	"github.com/yvanferez/meshqual/backend/internal/ingest"
)

// NodeRow is a persisted node.
type NodeRow struct {
	Key             string
	Name            string
	NodeType        uint8
	Latitude        *float64
	Longitude       *float64
	AdvertTimestamp *int64
	PathHashSize    uint8 // 0: unknown
	RegionScope     uint8 // ingest.RegionScope; 0: unknown
	FirstSeen       time.Time
	LastSeen        time.Time
}

// ObservationRow is a persisted reception.
type ObservationRow struct {
	At          time.Time
	SourceID    string
	ObserverKey string
	Region      string
	RouteType   uint8
	PayloadType uint8
	HopCount    int
	HashSize    int
	Path        []byte
	SNR         *float64
	RSSI        *int
	WireHash    string
	FrameLen    int
}

// Bucket is one point of a link's SNR history.
type Bucket struct {
	Bucket     time.Time `json:"bucket"`
	Kind       string    `json:"kind"`
	Samples    int64     `json:"samples"`
	SNRSamples int64     `json:"snrSamples"`
	SNRAvg     *float64  `json:"snrAvg"`
	SNRMin     *float64  `json:"snrMin"`
	SNRMax     *float64  `json:"snrMax"`
	RSSIAvg    *float64  `json:"rssiAvg"`
}

// Store is what the rest of the service needs from persistence. Keeping it an
// interface means the API and ingest can run against a no-op store, which is how
// the scaffold boots with no database at all.
type Store interface {
	Migrate(ctx context.Context) error
	UpsertNodes(ctx context.Context, nodes []NodeRow) error
	LoadNodes(ctx context.Context) ([]NodeRow, error)
	WriteObservations(ctx context.Context, rows []ObservationRow) error
	WriteSamples(ctx context.Context, samples []ingest.Sample) error
	LoadRecentSamples(ctx context.Context, since, measuredSince time.Time, limit int) ([]ingest.Sample, error)
	LinkHistory(ctx context.Context, a, b string, since time.Time, bucket time.Duration) ([]Bucket, error)
	Ping(ctx context.Context) error
	Close()
}

// Noop is a Store that discards everything. It lets the service run without a
// database: the live map still works, nothing survives a restart.
type Noop struct{}

func (Noop) Migrate(context.Context) error                             { return nil }
func (Noop) UpsertNodes(context.Context, []NodeRow) error              { return nil }
func (Noop) LoadNodes(context.Context) ([]NodeRow, error)              { return nil, nil }
func (Noop) WriteObservations(context.Context, []ObservationRow) error { return nil }
func (Noop) WriteSamples(context.Context, []ingest.Sample) error       { return nil }
func (Noop) Ping(context.Context) error                                { return nil }
func (Noop) Close()                                                    {}
func (Noop) LoadRecentSamples(context.Context, time.Time, time.Time, int) ([]ingest.Sample, error) {
	return []ingest.Sample{}, nil
}
func (Noop) LinkHistory(context.Context, string, string, time.Time, time.Duration) ([]Bucket, error) {
	return []Bucket{}, nil
}
