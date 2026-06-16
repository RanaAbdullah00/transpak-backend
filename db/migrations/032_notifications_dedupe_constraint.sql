/**
 * Fix notification ON CONFLICT (42P10): replace partial unique index with full constraint.
 * Idempotent — safe to re-run.
 */

-- Remove duplicate (receiver_id, dedupe_key) rows before enforcing full uniqueness
DELETE FROM notifications n
USING (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY receiver_id, dedupe_key
           ORDER BY created_at DESC, id DESC
         ) AS rn
  FROM notifications
  WHERE dedupe_key IS NOT NULL
    AND char_length(trim(dedupe_key)) > 0
) d
WHERE n.id = d.id
  AND d.rn > 1;

DROP INDEX IF EXISTS uq_notifications_receiver_dedupe;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'uq_notifications_receiver_dedupe_full'
      AND conrelid = 'notifications'::regclass
  ) THEN
    ALTER TABLE notifications
      ADD CONSTRAINT uq_notifications_receiver_dedupe_full
      UNIQUE (receiver_id, dedupe_key);
  END IF;
END $$;
