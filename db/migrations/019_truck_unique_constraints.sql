-- Global uniqueness for fleet identity (case-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS idx_trucks_license_plate_lower
  ON trucks (lower(trim(license_plate)))
  WHERE char_length(trim(coalesce(license_plate, ''))) > 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_trucks_engine_number_lower
  ON trucks (lower(trim(engine_number)))
  WHERE char_length(trim(coalesce(engine_number, ''))) > 0;
