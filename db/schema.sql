-- TransPak (FYP) PostgreSQL schema
-- Idempotent and safe to re-run.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Users
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  roles text[] NOT NULL DEFAULT ARRAY['shipper']::text[],
  active_role text NOT NULL DEFAULT 'shipper',
  blocked boolean NOT NULL DEFAULT false,
  verified boolean NOT NULL DEFAULT false,

  -- Profile completion fields (required by FYP)
  full_name text,
  phone text,
  cnic_number text UNIQUE,
  cnic_image text,
  profile_image text,
  is_profile_complete boolean NOT NULL DEFAULT false,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_roles ON users USING gin (roles);

-- CNIC back image (front remains cnic_image)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'cnic_image_back'
  ) THEN
    ALTER TABLE users ADD COLUMN cnic_image_back text;
  END IF;
END $$;

-- Legacy single-column role → roles[] (safe no-op if column never existed)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'role'
  ) THEN
    EXECUTE $m$
      UPDATE users
      SET roles = ARRAY(SELECT DISTINCT unnest(COALESCE(roles, ARRAY[]::text[]) || ARRAY[LOWER(TRIM(role))]::text[]))
      WHERE role IS NOT NULL AND TRIM(role) <> ''
    $m$;
    ALTER TABLE users DROP COLUMN IF EXISTS role;
  END IF;
END $$;

-- Loads
CREATE TABLE IF NOT EXISTS loads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  shipper_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cargo text NOT NULL,
  origin text NOT NULL,
  destination text NOT NULL,
  weight numeric NOT NULL DEFAULT 0,
  vehicle_type text NOT NULL,
  expected_price numeric NOT NULL DEFAULT 0,
  pickup_date date NOT NULL,
  deadline_hours int NOT NULL DEFAULT 2,
  deadline_minutes int,
  status text NOT NULL DEFAULT 'open', -- open/booked/closed/cancelled (shipment lifecycle is in shipments)
  assigned_carrier_id uuid REFERENCES users(id) ON DELETE SET NULL,
  accepted_bid_id uuid,
  booking_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_loads_shipper ON loads(shipper_id);
CREATE INDEX IF NOT EXISTS idx_loads_status ON loads(status);

-- Bids (carrier offers on loads)
CREATE TABLE IF NOT EXISTS bids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id uuid NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
  carrier_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending', -- pending/accepted/rejected/cancelled
  suggested_amount numeric,
  suggested_by text CHECK (suggested_by IN ('shipper','carrier')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bids_unique UNIQUE (load_id, carrier_id)
);

-- If table existed before suggestions were added, add columns safely.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'bids' AND column_name = 'suggested_amount'
  ) THEN
    ALTER TABLE bids ADD COLUMN suggested_amount numeric;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'bids' AND column_name = 'suggested_by'
  ) THEN
    ALTER TABLE bids ADD COLUMN suggested_by text CHECK (suggested_by IN ('shipper','carrier'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bids_load ON bids(load_id);
CREATE INDEX IF NOT EXISTS idx_bids_carrier ON bids(carrier_id);

-- Bookings
CREATE TABLE IF NOT EXISTS bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id uuid NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
  shipper_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  carrier_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending', -- pending/approved/rejected/cancelled
  price numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bookings_unique_load UNIQUE (load_id)
);

CREATE INDEX IF NOT EXISTS idx_bookings_shipper ON bookings(shipper_id);
CREATE INDEX IF NOT EXISTS idx_bookings_carrier ON bookings(carrier_id);

-- Shipments (tracking lifecycle)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'shipment_status') THEN
    CREATE TYPE shipment_status AS ENUM (
      'posted',
      'booked',
      'pickedup',
      'intransit',
      'delivered',
      'closed'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id uuid NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
  booking_id uuid REFERENCES bookings(id) ON DELETE SET NULL,
  status shipment_status NOT NULL DEFAULT 'posted',
  current_lat numeric,
  current_lng numeric,
  location_unavailable boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shipments_unique_load UNIQUE (load_id)
);

CREATE TABLE IF NOT EXISTS shipment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  status shipment_status NOT NULL,
  note text,
  location_label text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shipment_events_shipment ON shipment_events(shipment_id, created_at DESC);

-- Messaging (required table: messages)
CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id uuid REFERENCES loads(id) ON DELETE SET NULL,
  user_a_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conv_unique_pair UNIQUE (load_id, user_a_id, user_b_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body text,
  attachment_url text,
  attachment_public_id text,
  attachment_kind text,
  attachment_file_name text,
  seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messages_body_or_attachment CHECK (
    (char_length(trim(coalesce(body, ''))) > 0)
    OR (attachment_url IS NOT NULL AND char_length(trim(attachment_url)) > 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at DESC);

-- Payments removed (offline settlement for final demo direction).
-- Pricing lives on loads/bids/bookings; do not store/execute payments in-app.

-- Notifications
CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receiver_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_id uuid REFERENCES users(id) ON DELETE SET NULL,
  role_type text,
  title text NOT NULL,
  message text NOT NULL,
  read boolean NOT NULL DEFAULT false,
  event_id uuid,
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_receiver ON notifications(receiver_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(receiver_id) WHERE read = false;
-- Full unique constraint (migration 032); partial index replaced for ON CONFLICT compatibility
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS uq_notifications_receiver_dedupe_full;
ALTER TABLE notifications ADD CONSTRAINT uq_notifications_receiver_dedupe_full UNIQUE (receiver_id, dedupe_key);

-- Wallet removed (offline settlement).

-- Trucks (carrier profile)
CREATE TABLE IF NOT EXISTS trucks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  engine_number text NOT NULL,
  truck_type text NOT NULL,
  license_plate text NOT NULL,
  capacity numeric NOT NULL DEFAULT 0,
  chassis_number text,
  status text NOT NULL DEFAULT 'pending',
  is_default boolean NOT NULL DEFAULT false,
  truck_card_front_image text NOT NULL DEFAULT '',
  truck_card_back_image text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trucks_status_check CHECK (status IN ('pending', 'approved', 'suspended'))
);

CREATE INDEX IF NOT EXISTS idx_trucks_user ON trucks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trucks_user_status_default ON trucks(user_id, status, is_default DESC, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_trucks_user_engine ON trucks(user_id, engine_number);

-- Demo video (admin managed)
CREATE TABLE IF NOT EXISTS demo_video_meta (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url text NOT NULL,
  mime_type text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Disputes (admin managed)
CREATE TABLE IF NOT EXISTS disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid REFERENCES shipments(id) ON DELETE SET NULL,
  load_id uuid REFERENCES loads(id) ON DELETE SET NULL,
  load_code text,
  raised_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status, created_at DESC);

-- Ratings & feedback
CREATE TABLE IF NOT EXISTS ratings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  from_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score int NOT NULL CHECK (score >= 1 AND score <= 5),
  comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ratings_unique UNIQUE (shipment_id, from_user_id)
);

-- Pending signup: OTP + profile fields before users row exists
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

-- Email OTP (registration + password reset)
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

CREATE INDEX IF NOT EXISTS idx_email_otp_email_purpose_created
  ON email_otp_challenges (lower(trim(email)), purpose, created_at DESC);

-- Generic auth OTP (POST /api/auth/send-otp, /verify-otp)
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

