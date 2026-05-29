-- Phase 5: canonical fleet lifecycle statuses
UPDATE trucks SET status = 'approved' WHERE status = 'active';
UPDATE trucks SET status = 'pending' WHERE status = 'pending_verification';

ALTER TABLE trucks DROP CONSTRAINT IF EXISTS trucks_status_check;
ALTER TABLE trucks
  ADD CONSTRAINT trucks_status_check
  CHECK (status IN ('pending', 'approved', 'suspended'));

CREATE INDEX IF NOT EXISTS idx_trucks_user_status_default
  ON trucks (user_id, status, is_default DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trucks_pending_review
  ON trucks (status, created_at DESC)
  WHERE status = 'pending';
