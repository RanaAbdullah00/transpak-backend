-- Additive: server-side review prompt dismiss preferences (replaces session-only skip).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS review_prompt_dismissed JSONB NOT NULL DEFAULT '[]'::jsonb;
