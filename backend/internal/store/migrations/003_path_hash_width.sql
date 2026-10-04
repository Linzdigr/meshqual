-- Path hash width (1..3 bytes) a node uses for the packets it originates, read
-- from its flood adverts. NULL until one is seen. 1-byte hashes collide often,
-- which is why the map flags those nodes.
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS path_hash_width SMALLINT;

-- A first version (column path_hash_size) also read zero-hop adverts, whose
-- path_len of 0 always looks like 1 byte. Its values cannot be told apart from
-- real ones, so they go: every node is re-learned from its next flood advert.
ALTER TABLE nodes DROP COLUMN IF EXISTS path_hash_size;
