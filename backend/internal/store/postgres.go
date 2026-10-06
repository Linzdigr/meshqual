package store

import (
	"context"
	"embed"
	"encoding/hex"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/yvanferez/meshqual/backend/internal/ingest"
)

//go:embed migrations/*.sql
var migrations embed.FS

// Postgres is a TimescaleDB-backed Store.
type Postgres struct {
	pool *pgxpool.Pool
	log  *slog.Logger
}

// Open connects and verifies the connection.
func Open(ctx context.Context, dsn string, log *slog.Logger) (*Postgres, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("store: bad dsn: %w", err)
	}
	// The write path is a handful of batching goroutines plus API reads; a large
	// pool would just add contention.
	if cfg.MaxConns < 4 {
		cfg.MaxConns = 8
	}
	cfg.MaxConnIdleTime = 5 * time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("store: connect: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("store: ping: %w", err)
	}
	return &Postgres{pool: pool, log: log}, nil
}

func (p *Postgres) Close() { p.pool.Close() }

func (p *Postgres) Ping(ctx context.Context) error { return p.pool.Ping(ctx) }

// Migrate applies the embedded SQL in filename order. 002 needs a real
// TimescaleDB; a failure there is logged and tolerated so the service still
// starts against plain PostgreSQL, just without retention and compression.
func (p *Postgres) Migrate(ctx context.Context) error {
	entries, err := migrations.ReadDir("migrations")
	if err != nil {
		return err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sortStrings(names)

	for _, name := range names {
		body, err := migrations.ReadFile("migrations/" + name)
		if err != nil {
			return err
		}
		if _, err := p.pool.Exec(ctx, string(body)); err != nil {
			if strings.HasPrefix(name, "002") {
				p.log.Warn("optional migration failed; running without retention/compression policies",
					"migration", name, "err", err)
				continue
			}
			return fmt.Errorf("store: migration %s: %w", name, err)
		}
		p.log.Info("migration applied", "migration", name)
	}
	return nil
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

func key(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		return nil
	}
	return b
}

func hexUpper(b []byte) string { return strings.ToUpper(hex.EncodeToString(b)) }

// UpsertNodes writes node identity and position. A node that has reported a
// position keeps it: COALESCE means a later positionless advert cannot blank it.
func (p *Postgres) UpsertNodes(ctx context.Context, nodes []NodeRow) error {
	if len(nodes) == 0 {
		return nil
	}
	batch := &pgx.Batch{}
	for _, n := range nodes {
		batch.Queue(`
INSERT INTO nodes (public_key, name, node_type, latitude, longitude, advert_timestamp, path_hash_width, region_scope, first_seen, last_seen)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), now())
ON CONFLICT (public_key) DO UPDATE SET
  name             = CASE WHEN excluded.name <> '' THEN excluded.name ELSE nodes.name END,
  node_type        = CASE WHEN excluded.node_type <> 0 THEN excluded.node_type ELSE nodes.node_type END,
  latitude         = COALESCE(excluded.latitude,  nodes.latitude),
  longitude        = COALESCE(excluded.longitude, nodes.longitude),
  advert_timestamp = GREATEST(COALESCE(excluded.advert_timestamp, 0), COALESCE(nodes.advert_timestamp, 0)),
  path_hash_width  = COALESCE(excluded.path_hash_width, nodes.path_hash_width),
  region_scope     = COALESCE(excluded.region_scope, nodes.region_scope),
  last_seen        = now()`,
			key(n.Key), n.Name, int16(n.NodeType), n.Latitude, n.Longitude, n.AdvertTimestamp,
			hashSize(n.PathHashSize), hashSize(n.RegionScope))
	}
	return p.pool.SendBatch(ctx, batch).Close()
}

// hashSize maps "unknown" (0) to NULL, so an upsert never erases a known value
// (path hash width, region scope).
func hashSize(v uint8) *int16 {
	if v == 0 {
		return nil
	}
	s := int16(v)
	return &s
}

// LoadNodes reads every node, used to warm the resolver at startup.
func (p *Postgres) LoadNodes(ctx context.Context) ([]NodeRow, error) {
	rows, err := p.pool.Query(ctx, `
SELECT public_key, name, node_type, latitude, longitude, advert_timestamp, path_hash_width, region_scope, first_seen, last_seen
FROM nodes`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []NodeRow{}
	for rows.Next() {
		var (
			pk       []byte
			nodeType int16
			hashSz   *int16
			scope    *int16
			n        NodeRow
		)
		if err := rows.Scan(&pk, &n.Name, &nodeType, &n.Latitude, &n.Longitude,
			&n.AdvertTimestamp, &hashSz, &scope, &n.FirstSeen, &n.LastSeen); err != nil {
			return nil, err
		}
		n.Key, n.NodeType = hexUpper(pk), uint8(nodeType)
		if hashSz != nil {
			n.PathHashSize = uint8(*hashSz)
		}
		if scope != nil {
			n.RegionScope = uint8(*scope)
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// WriteObservations bulk-loads the raw archive.
func (p *Postgres) WriteObservations(ctx context.Context, rows []ObservationRow) error {
	if len(rows) == 0 {
		return nil
	}
	_, err := p.pool.CopyFrom(ctx,
		pgx.Identifier{"observations"},
		[]string{"time", "source_id", "observer_key", "region", "route_type", "payload_type",
			"hop_count", "hash_size", "path", "snr", "rssi", "wire_hash", "frame_len"},
		pgx.CopyFromSlice(len(rows), func(i int) ([]any, error) {
			r := rows[i]
			var rssi *int16
			if r.RSSI != nil {
				v := int16(*r.RSSI)
				rssi = &v
			}
			return []any{
				r.At, r.SourceID, key(r.ObserverKey), r.Region, int16(r.RouteType), int16(r.PayloadType),
				int16(r.HopCount), int16(r.HashSize), r.Path, r.SNR, rssi, key(r.WireHash), r.FrameLen,
			}, nil
		}))
	return err
}

// WriteSamples bulk-loads link samples.
func (p *Postgres) WriteSamples(ctx context.Context, samples []ingest.Sample) error {
	if len(samples) == 0 {
		return nil
	}
	_, err := p.pool.CopyFrom(ctx,
		pgx.Identifier{"link_samples"},
		[]string{"time", "a_key", "b_key", "forward", "kind", "snr", "rssi",
			"observer_key", "payload_type", "route_type", "hop_index", "hop_count", "source_id", "wire_hash"},
		pgx.CopyFromSlice(len(samples), func(i int) ([]any, error) {
			s := samples[i]
			var rssi *int16
			if s.RSSI != nil {
				v := int16(*s.RSSI)
				rssi = &v
			}
			return []any{
				s.At, key(s.AKey), key(s.BKey), s.Forward, int16(s.Kind), s.SNR, rssi,
				key(s.ObserverKey), int16(s.PayloadType), int16(s.RouteType),
				int16(s.HopIndex), int16(s.HopCount), s.SourceID, key(s.WireHash),
			}, nil
		}))
	return err
}

// LoadRecentSamples warms the in-memory aggregator after a restart, newest
// first: every sample since `since`, and those carrying a signal value back to
// `measuredSince`.
func (p *Postgres) LoadRecentSamples(ctx context.Context, since, measuredSince time.Time, limit int) ([]ingest.Sample, error) {
	rows, err := p.pool.Query(ctx, `
SELECT time, a_key, b_key, forward, kind, snr, rssi, observer_key,
       payload_type, route_type, hop_index, hop_count, source_id, wire_hash
FROM link_samples
WHERE time >= LEAST($1, $2::timestamptz)
  AND (time >= $1 OR snr IS NOT NULL OR rssi IS NOT NULL)
ORDER BY time DESC
LIMIT $3`, since, measuredSince, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []ingest.Sample{}
	for rows.Next() {
		var (
			s                                              ingest.Sample
			a, b, obs, wire                                []byte
			kind, payloadType, routeType, hopIdx, hopCount int16
			rssi                                           *int16
		)
		if err := rows.Scan(&s.At, &a, &b, &s.Forward, &kind, &s.SNR, &rssi, &obs,
			&payloadType, &routeType, &hopIdx, &hopCount, &s.SourceID, &wire); err != nil {
			return nil, err
		}
		s.AKey, s.BKey = hexUpper(a), hexUpper(b)
		s.ObserverKey, s.WireHash = hexUpper(obs), hexUpper(wire)
		s.Kind = ingest.Kind(kind)
		s.PayloadType, s.RouteType = uint8(payloadType), uint8(routeType)
		s.HopIndex, s.HopCount = int(hopIdx), int(hopCount)
		if rssi != nil {
			v := int(*rssi)
			s.RSSI = &v
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// LinkHistory returns the SNR history of one link.
//
// It reads the raw hypertable with time_bucket rather than the continuous
// aggregate, so an arbitrary bucket width works and the most recent minutes are
// included -- the aggregate lags by its end_offset by design. Swap in
// link_stats_1h here if a multi-month window ever gets slow.
func (p *Postgres) LinkHistory(ctx context.Context, a, b string, since time.Time, bucket time.Duration) ([]Bucket, error) {
	ka, kb := key(a), key(b)
	if ka == nil || kb == nil {
		return nil, fmt.Errorf("store: bad link keys")
	}
	if bucket <= 0 {
		bucket = time.Hour
	}
	rows, err := p.pool.Query(ctx, `
SELECT time_bucket(make_interval(secs => $4), time) AS bucket,
       kind, count(*), count(snr), avg(snr), min(snr), max(snr), avg(rssi::double precision)
FROM link_samples
WHERE a_key = $1 AND b_key = $2 AND time >= $3
GROUP BY bucket, kind
ORDER BY bucket`, ka, kb, since, bucket.Seconds())
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Bucket{}
	for rows.Next() {
		var (
			bk   Bucket
			kind int16
		)
		if err := rows.Scan(&bk.Bucket, &kind, &bk.Samples, &bk.SNRSamples,
			&bk.SNRAvg, &bk.SNRMin, &bk.SNRMax, &bk.RSSIAvg); err != nil {
			return nil, err
		}
		bk.Kind = ingest.Kind(kind).String()
		out = append(out, bk)
	}
	return out, rows.Err()
}
