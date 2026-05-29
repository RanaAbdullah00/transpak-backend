-- Repair DBs where legacy 020 re-applied old trucks_status_check (Render deploy fix, run once)
ALTER TABLE trucks DROP CONSTRAINT IF EXISTS trucks_status_check;

UPDATE trucks SET status = 'approved' WHERE lower(trim(status)) IN ('active', 'approved');
UPDATE trucks SET status = 'pending' WHERE lower(trim(status)) IN ('pending_verification', 'pending');
UPDATE trucks SET status = 'suspended' WHERE lower(trim(status)) = 'suspended';
UPDATE trucks SET status = 'pending'
WHERE status IS NULL OR lower(trim(status)) NOT IN ('pending', 'approved', 'suspended');

DO $$
BEGIN
  ALTER TABLE trucks
    ADD CONSTRAINT trucks_status_check
    CHECK (status IN ('pending', 'approved', 'suspended'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
