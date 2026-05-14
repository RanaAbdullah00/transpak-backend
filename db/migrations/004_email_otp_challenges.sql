-- Email OTP challenges (registration + password reset). Idempotent.
--
-- Apply once against your TransPak Postgres database, e.g.:
--   psql "$DATABASE_URL" -f transpak-backend/db/migrations/004_email_otp_challenges.sql
-- Required for POST /api/auth/otp/register/verify|resend and /api/auth/otp/forgot/send|reset
-- (see routes/authRoutes.js). Not JWT-protected; use rate limits + hashed codes + expiry.

BEGIN;

CREATE TABLE IF NOT EXISTS email_otp_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('register_verify', 'password_reset')),
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  attempt_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_otp_open
  ON email_otp_challenges (lower(email), purpose, created_at DESC)
  WHERE consumed_at IS NULL;

-- Supports resend cooldown (max created_at per email+purpose) and admin queries; safe alongside partial index above.
CREATE INDEX IF NOT EXISTS idx_email_otp_email_purpose_created
  ON email_otp_challenges (lower(trim(email)), purpose, created_at DESC);

COMMIT;
