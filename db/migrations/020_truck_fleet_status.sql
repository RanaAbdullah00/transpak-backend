-- Fleet status + default truck selection
ALTER TABLE trucks
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS chassis_number text;

ALTER TABLE trucks DROP CONSTRAINT IF EXISTS trucks_status_check;
ALTER TABLE trucks
  ADD CONSTRAINT trucks_status_check
  CHECK (status IN ('active', 'pending_verification', 'suspended'));

CREATE INDEX IF NOT EXISTS idx_trucks_user_status ON trucks(user_id, status);
CREATE INDEX IF NOT EXISTS idx_trucks_plate_lower ON trucks(lower(trim(license_plate)));
CREATE UNIQUE INDEX IF NOT EXISTS uq_trucks_chassis ON trucks(chassis_number) WHERE chassis_number IS NOT NULL AND char_length(trim(chassis_number)) > 0;
