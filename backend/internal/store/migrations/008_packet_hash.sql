-- The firmware's packet hash (Packet::calculatePacketHash, 8 bytes): the same
-- on every copy of a packet, whichever relays carried it, so the receptions of
-- one packet can be gathered to draw the way it went. origin_key: the sender,
-- when the packet names it in full (adverts).
ALTER TABLE observations ADD COLUMN IF NOT EXISTS packet_hash BYTEA;
ALTER TABLE observations ADD COLUMN IF NOT EXISTS origin_key BYTEA;
CREATE INDEX IF NOT EXISTS observations_packet_hash_idx ON observations (packet_hash, time DESC);
