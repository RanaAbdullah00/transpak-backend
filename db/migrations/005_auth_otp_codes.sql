-- Generic auth OTP (signup/login verification). Apply once:
--   psql "$DATABASE_URL" -f transpak-backend/db/migrations/005_auth_otp_codes.sql

BEGIN;

CREATE TABLE IF NOT EXISTS auth_otp_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  otp_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  is_verified boolean NOT NULL DEFAULT false,
  attempt_count int NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_auth_otp_open
  ON auth_otp_codes (lower(trim(email)), created_at DESC)
  WHERE is_verified = false;

CREATE INDEX IF NOT EXISTS idx_auth_otp_email_created
  ON auth_otp_codes (lower(trim(email)), created_at DESC);

COMMIT;
