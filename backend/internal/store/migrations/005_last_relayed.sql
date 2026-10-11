-- When a node was last named in a packet's path, i.e. seen relaying. Kept so
-- an observer that relays stays an ordinary node across restarts, instead of
-- being taken for a listen-only one until it relays again.
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS last_relayed TIMESTAMPTZ;
