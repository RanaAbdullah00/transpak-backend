-- Bidding deadline in minutes (supports sub-hour bidding windows)
ALTER TABLE loads ADD COLUMN IF NOT EXISTS deadline_minutes INTEGER;

UPDATE loads
SET deadline_minutes = GREATEST(COALESCE(deadline_hours, 2), 1) * 60
WHERE deadline_minutes IS NULL;
