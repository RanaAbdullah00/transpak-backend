-- Carrier capacity availability time slots (jsonb array of { start, end } local times)
ALTER TABLE carrier_space_listings
  ADD COLUMN IF NOT EXISTS availability_slots jsonb DEFAULT NULL;
