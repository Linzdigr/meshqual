-- Whether a node floods its own packets under a default region (MeshCore v1.10+
-- `region default <name>`), read from its flood adverts: 1 none, 2 set, NULL
-- until one is seen. Unscoped floods are dropped by repeaters set to
-- `region denyf *`, which is why the map flags those nodes.
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS region_scope SMALLINT;
