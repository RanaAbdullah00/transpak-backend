-- Persist ORS/haversine route snapshot on load; GPS history for tracking audit
ALTER TABLE loads
  ADD COLUMN IF NOT EXISTS route_coordinates JSONB,
  ADD COLUMN IF NOT EXISTS route_distance_km NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS route_source VARCHAR(32);

CREATE TABLE IF NOT EXISTS shipment_location_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id UUID NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shipment_location_log_load_time
  ON shipment_location_log (load_id, recorded_at DESC);
