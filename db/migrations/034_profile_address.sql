-- Profile address field (web + mobile parity)
ALTER TABLE users ADD COLUMN IF NOT EXISTS address TEXT;

COMMENT ON COLUMN users.address IS 'Optional user address (shipper/carrier profile)';
