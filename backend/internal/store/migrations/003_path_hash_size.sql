-- Path hash width (1..4 bytes) a node uses for the packets it originates, read
-- from its adverts. NULL until an advert has been seen. 1-byte hashes collide
-- often, which is why the map flags those nodes.
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS path_hash_size SMALLINT;
