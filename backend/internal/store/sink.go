package store

import (
	"context"
	"time"

	"github.com/yvanferez/meshqual/backend/internal/ingest"
)

// Sink adapts a Store to ingest.Sink, keeping the ingest package free of any
// storage types.
type Sink struct{ S Store }

// WriteSamples persists link samples.
func (a Sink) WriteSamples(ctx context.Context, samples []ingest.Sample) error {
	return a.S.WriteSamples(ctx, samples)
}

// WriteReceptions archives raw receptions.
func (a Sink) WriteReceptions(ctx context.Context, recs []ingest.Reception) error {
	rows := make([]ObservationRow, len(recs))
	for i, r := range recs {
		rows[i] = ObservationRow{
			At: r.At, SourceID: r.SourceID, ObserverKey: r.ObserverKey, Region: r.Region,
			RouteType: r.RouteType, PayloadType: r.PayloadType, HopCount: r.HopCount, HashSize: r.HashSize,
			Path: r.Path, SNR: r.SNR, RSSI: r.RSSI, WireHash: r.WireHash, PacketHash: r.PacketHash,
			OriginKey: r.OriginKey, FrameLen: r.FrameLen,
		}
	}
	return a.S.WriteObservations(ctx, rows)
}

// MarkRelayed persists when nodes were last seen relaying.
func (a Sink) MarkRelayed(ctx context.Context, at map[string]time.Time) error {
	return a.S.MarkRelayed(ctx, at)
}

// UpsertNodes persists node facts learned from adverts.
func (a Sink) UpsertNodes(ctx context.Context, nodes []ingest.NodeUpsert) error {
	rows := make([]NodeRow, 0, len(nodes))
	for _, n := range nodes {
		row := NodeRow{
			Key: n.Key, Name: n.Name, NodeType: n.NodeType,
			Latitude: n.Latitude, Longitude: n.Longitude, AdvertTimestamp: n.AdvertTimestamp,
			PathHashSize: n.PathHashSize, RegionScope: uint8(n.RegionScope), RegionName: n.RegionName,
		}
		if !n.ClockAt.IsZero() {
			off, at := int64(n.ClockOffset/time.Second), n.ClockAt
			row.ClockOffsetSec, row.ClockAt = &off, &at
		}
		rows = append(rows, row)
	}
	return a.S.UpsertNodes(ctx, rows)
}
