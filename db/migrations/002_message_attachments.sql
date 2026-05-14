-- Chat message attachments (image / PDF). Run once on existing DBs.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_url text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_public_id text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_kind text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_file_name text;

ALTER TABLE messages ALTER COLUMN body DROP NOT NULL;

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_body_or_attachment;
ALTER TABLE messages ADD CONSTRAINT messages_body_or_attachment CHECK (
  (char_length(trim(coalesce(body, ''))) > 0)
  OR (attachment_url IS NOT NULL AND char_length(trim(attachment_url)) > 0)
);
