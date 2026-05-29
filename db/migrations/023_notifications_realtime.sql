/**
 * Phase 6 — notification deduplication + sync performance (idempotent).
 * Safe to re-run: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS only.
 */
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS event_id uuid,
  ADD COLUMN IF NOT EXISTS dedupe_key text;

UPDATE notifications SET event_id = id WHERE event_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_receiver_dedupe
  ON notifications (receiver_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND char_length(trim(dedupe_key)) > 0;

CREATE INDEX IF NOT EXISTS idx_notifications_receiver_created_role
  ON notifications (receiver_id, role_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_sync
  ON notifications (receiver_id, created_at DESC)
  WHERE read = false;
