CREATE TABLE IF NOT EXISTS carrier_space_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  carrier_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  origin text NOT NULL,
  destination text NOT NULL,
  truck_capacity_kg numeric NOT NULL DEFAULT 0,
  remaining_space_kg numeric NOT NULL DEFAULT 0,
  vehicle_type text NOT NULL DEFAULT 'Truck',
  rate_per_kg numeric,
  available_from date,
  notes text,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT carrier_space_status CHECK (status IN ('open', 'booked', 'closed'))
);

CREATE INDEX IF NOT EXISTS idx_carrier_space_carrier ON carrier_space_listings(carrier_id);
CREATE INDEX IF NOT EXISTS idx_carrier_space_status ON carrier_space_listings(status);
CREATE INDEX IF NOT EXISTS idx_carrier_space_route ON carrier_space_listings(origin, destination);
