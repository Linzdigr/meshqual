-- Retention, compression and refresh policies. Separated from the schema so the
-- schema can be applied to a plain PostgreSQL instance for tests while these
-- need a real TimescaleDB.
SELECT add_continuous_aggregate_policy('link_stats_1h',
    start_offset      => INTERVAL '3 days',
    end_offset        => INTERVAL '1 hour',
    schedule_interval => INTERVAL '30 minutes',
    if_not_exists     => TRUE);

SELECT add_retention_policy('observations', INTERVAL '30 days', if_not_exists => TRUE);
SELECT add_retention_policy('link_samples', INTERVAL '90 days', if_not_exists => TRUE);

ALTER TABLE observations SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'observer_key',
    timescaledb.compress_orderby   = 'time DESC');

ALTER TABLE link_samples SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'a_key, b_key',
    timescaledb.compress_orderby   = 'time DESC');

SELECT add_compression_policy('observations', INTERVAL '7 days',  if_not_exists => TRUE);
SELECT add_compression_policy('link_samples', INTERVAL '14 days', if_not_exists => TRUE);
