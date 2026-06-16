-- Performance indexes for history, notifications, and bid lists (Issue 22)
CREATE INDEX IF NOT EXISTS idx_loads_shipper_status_updated
  ON loads (shipper_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_loads_carrier_status_updated
  ON loads (assigned_carrier_id, status, updated_at DESC)
  WHERE assigned_carrier_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shipments_load_status_updated
  ON shipments (load_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_receiver_read_created
  ON notifications (receiver_id, read, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bids_carrier_status_created
  ON bids (carrier_id, status, created_at DESC);
