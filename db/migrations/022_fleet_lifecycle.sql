-- Phase 5 indexes only (status constraint owned by 020 / 024 — idempotent)
CREATE INDEX IF NOT EXISTS idx_trucks_user_status_default
  ON trucks (user_id, status, is_default DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trucks_pending_review
  ON trucks (status, created_at DESC)
  WHERE status = 'pending';
