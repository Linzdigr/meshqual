package store

import (
	"context"

	"github.com/yvanferez/meshqual/backend/internal/ingest"
)

// Sink adapts a Store to ingest.Sink, keeping the ingest package free of any
// storage types.
type Sink struct{ S Store }

// WriteSamples persists link samples.
func (a Sink) WriteSamples(ctx context.Context, samples []ingest.Sample) error {
	return a.S.WriteSamples(ctx, samples)
}

// UpsertNodes persists node facts learned from adverts.
func (a Sink) UpsertNodes(ctx context.Context, nodes []ingest.NodeUpsert) error {
	rows := make([]NodeRow, 0, len(nodes))
	for _, n := range nodes {
		rows = append(rows, NodeRow{
			Key: n.Key, Name: n.Name, NodeType: n.NodeType,
			Latitude: n.Latitude, Longitude: n.Longitude, AdvertTimestamp: n.AdvertTimestamp,
			PathHashSize: n.PathHashSize,
		})
	}
	return a.S.UpsertNodes(ctx, rows)
}
