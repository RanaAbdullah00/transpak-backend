-- Idempotent indexes for common list/filter queries
CREATE INDEX IF NOT EXISTS idx_loads_status_created ON loads (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bids_load_id_status ON bids (load_id, status);
CREATE INDEX IF NOT EXISTS idx_shipments_load_id ON shipments (load_id);
CREATE INDEX IF NOT EXISTS idx_shipments_status_updated ON shipments (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_receiver_created ON notifications (receiver_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_created_day ON notifications (created_at DESC);
