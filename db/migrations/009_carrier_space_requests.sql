CREATE TABLE IF NOT EXISTS carrier_space_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES carrier_space_listings(id) ON DELETE CASCADE,
  shipper_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_kg numeric NOT NULL CHECK (requested_kg > 0),
  message text,
  status text NOT NULL DEFAULT 'request_sent',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT carrier_space_req_status CHECK (
    status IN ('request_sent', 'accepted', 'rejected', 'active', 'completed')
  ),
  CONSTRAINT carrier_space_req_unique UNIQUE (listing_id, shipper_id)
);

CREATE INDEX IF NOT EXISTS idx_space_req_listing ON carrier_space_requests(listing_id);
CREATE INDEX IF NOT EXISTS idx_space_req_shipper ON carrier_space_requests(shipper_id);
