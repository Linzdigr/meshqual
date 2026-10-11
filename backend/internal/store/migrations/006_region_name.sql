-- The default region a node's scoped adverts carry, when its name is among
-- the candidates relayd tries (config regionNames): the advert only holds a
-- code keyed by the name. NULL when unscoped, unknown or private.
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS region_name TEXT;
