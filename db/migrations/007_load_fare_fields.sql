ALTER TABLE loads ADD COLUMN IF NOT EXISTS distance_km numeric;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS suggested_fare numeric;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS pickup_location text;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS drop_location text;

UPDATE loads
SET pickup_location = COALESCE(pickup_location, origin),
    drop_location = COALESCE(drop_location, destination)
WHERE pickup_location IS NULL OR drop_location IS NULL;
