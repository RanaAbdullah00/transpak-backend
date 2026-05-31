-- Link capacity requests to unified freight loads/shipments
ALTER TABLE carrier_space_requests
  ADD COLUMN IF NOT EXISTS load_id uuid REFERENCES loads(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_space_req_load ON carrier_space_requests(load_id);
