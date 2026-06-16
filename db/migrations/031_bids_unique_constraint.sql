-- Ensure one bid per carrier per load (idempotent for DBs bootstrapped without schema.sql).
CREATE UNIQUE INDEX IF NOT EXISTS bids_unique_load_carrier
  ON bids (load_id, carrier_id);
