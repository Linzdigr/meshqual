-- meshqual schema. Idempotent: safe to re-run.
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Nodes are learned passively from ADVERT packets: that is the only packet type
-- that carries identity and position.
CREATE TABLE IF NOT EXISTS nodes (
    public_key       BYTEA PRIMARY KEY,
    name             TEXT        NOT NULL DEFAULT '',
    node_type        SMALLINT    NOT NULL DEFAULT 0,
    latitude         DOUBLE PRECISION,
    longitude        DOUBLE PRECISION,
    advert_timestamp BIGINT,
    first_seen       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS nodes_position_idx
    ON nodes (latitude, longitude) WHERE latitude IS NOT NULL;

-- Raw archive: one row per reception. Kept so a link can be re-derived after a
-- resolver improvement without having to re-observe the mesh.
CREATE TABLE IF NOT EXISTS observations (
    time         TIMESTAMPTZ NOT NULL,
    id           BIGSERIAL,
    source_id    TEXT        NOT NULL,
    observer_key BYTEA,
    region       TEXT,
    route_type   SMALLINT    NOT NULL,
    payload_type SMALLINT    NOT NULL,
    hop_count    SMALLINT    NOT NULL,
    hash_size    SMALLINT    NOT NULL,
    path         BYTEA,
    snr          DOUBLE PRECISION,
    rssi         SMALLINT,
    wire_hash    BYTEA,
    frame_len    INTEGER,
    PRIMARY KEY (time, id)
);

SELECT create_hypertable('observations', 'time',
    chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS observations_wire_hash_idx ON observations (wire_hash, time DESC);
CREATE INDEX IF NOT EXISTS observations_observer_idx  ON observations (observer_key, time DESC);

-- The core table: every link sample, with its provenance.
--   kind 0 = topology (adjacent hops; NO signal measurement exists)
--   kind 1 = measured (last hop -> observer; the observer's own radio)
--   kind 2 = trace    (per-hop SNR appended by each forwarder)
-- a_key < b_key always, so a pair has exactly one identity; `forward` carries
-- the direction the frame actually travelled.
CREATE TABLE IF NOT EXISTS link_samples (
    time         TIMESTAMPTZ NOT NULL,
    a_key        BYTEA       NOT NULL,
    b_key        BYTEA       NOT NULL,
    forward      BOOLEAN     NOT NULL,
    kind         SMALLINT    NOT NULL,
    snr          DOUBLE PRECISION,
    rssi         SMALLINT,
    observer_key BYTEA,
    payload_type SMALLINT,
    route_type   SMALLINT,
    hop_index    SMALLINT,
    hop_count    SMALLINT,
    source_id    TEXT,
    wire_hash    BYTEA
);

SELECT create_hypertable('link_samples', 'time',
    chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS link_samples_pair_idx ON link_samples (a_key, b_key, time DESC);
CREATE INDEX IF NOT EXISTS link_samples_kind_idx ON link_samples (kind, time DESC);

-- Hourly rollup per link and kind. max(time) is deliberately NOT in here: the
-- "last seen" value comes from the raw hypertable via link_samples_pair_idx,
-- which keeps this aggregate portable across TimescaleDB versions.
CREATE MATERIALIZED VIEW IF NOT EXISTS link_stats_1h
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', time)            AS bucket,
       a_key,
       b_key,
       kind,
       count(*)                                AS samples,
       count(snr)                              AS snr_samples,
       avg(snr)                                AS snr_avg,
       min(snr)                                AS snr_min,
       max(snr)                                AS snr_max,
       stddev_samp(snr)                        AS snr_stddev,
       avg(rssi::double precision)             AS rssi_avg
FROM link_samples
GROUP BY bucket, a_key, b_key, kind
WITH NO DATA;
