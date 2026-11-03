-- How far a node's clock was from relayd's when its latest advert first
-- arrived (adverts carry the sender's time), in seconds, and when that was.
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS clock_offset_s BIGINT;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS clock_at TIMESTAMPTZ;
