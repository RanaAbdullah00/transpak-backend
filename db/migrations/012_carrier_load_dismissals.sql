-- Carrier passed on a load (hide from their freight board only)
CREATE TABLE IF NOT EXISTS carrier_load_dismissals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id UUID NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
  carrier_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (load_id, carrier_id)
);

CREATE INDEX IF NOT EXISTS idx_carrier_load_dismissals_carrier ON carrier_load_dismissals(carrier_id, created_at DESC);
