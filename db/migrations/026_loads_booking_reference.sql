-- Ensure loads.booking_reference exists (capacity ↔ shipment bridge / active list flowType).
ALTER TABLE loads ADD COLUMN IF NOT EXISTS booking_reference text;
