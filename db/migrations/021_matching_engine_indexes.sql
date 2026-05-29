-- Phase 4: marketplace matching query performance
CREATE INDEX IF NOT EXISTS idx_loads_open_vehicle_lower
  ON loads (status, lower(trim(vehicle_type)))
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_loads_open_pickup
  ON loads (status, pickup_date)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_loads_open_created
  ON loads (status, created_at DESC)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_trucks_user_approved_type
  ON trucks (user_id, lower(trim(truck_type)))
  WHERE status = 'approved';

CREATE INDEX IF NOT EXISTS idx_bids_carrier_load
  ON bids (carrier_id, load_id);

CREATE INDEX IF NOT EXISTS idx_carrier_dismissals_carrier_load
  ON carrier_load_dismissals (carrier_id, load_id);
