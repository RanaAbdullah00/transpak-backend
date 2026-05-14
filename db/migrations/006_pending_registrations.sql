-- Pending signup (OTP verified before users row is created). Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS pending_registrations (
  email text PRIMARY KEY,
  phone text NOT NULL,
  cnic_number text NOT NULL,
  full_name text,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (lower(trim(role)) IN ('shipper', 'carrier')),
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempt_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pending_registrations_updated
  ON pending_registrations (lower(trim(email)), updated_at DESC);

COMMIT;
