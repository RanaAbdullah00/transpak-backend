-- Allow ratings for completed capacity contracts (space requests) in addition to shipments.
ALTER TABLE ratings ALTER COLUMN shipment_id DROP NOT NULL;

ALTER TABLE ratings
  ADD COLUMN IF NOT EXISTS space_request_id uuid REFERENCES carrier_space_requests(id) ON DELETE CASCADE;

ALTER TABLE ratings DROP CONSTRAINT IF EXISTS ratings_source_check;
ALTER TABLE ratings ADD CONSTRAINT ratings_source_check CHECK (
  (shipment_id IS NOT NULL AND space_request_id IS NULL)
  OR (shipment_id IS NULL AND space_request_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS ratings_space_request_from_unique
  ON ratings (space_request_id, from_user_id)
  WHERE space_request_id IS NOT NULL;
