-- Idempotent: profile image columns + bid suggestion columns (align DB with app)
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'cnic_image_back'
  ) THEN
    ALTER TABLE users ADD COLUMN cnic_image_back text;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'bids' AND column_name = 'suggested_amount'
  ) THEN
    ALTER TABLE bids ADD COLUMN suggested_amount numeric;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'bids' AND column_name = 'suggested_by'
  ) THEN
    ALTER TABLE bids ADD COLUMN suggested_by text;
  END IF;
END $$;

COMMIT;
