-- Phase 6 — distributed idempotency, global sequencing, shipment event replay log

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope VARCHAR(64) NOT NULL,
  idempotency_key VARCHAR(240) NOT NULL,
  status_code INT NOT NULL,
  response_body JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
  PRIMARY KEY (scope, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idempotency_keys_expires_idx
  ON idempotency_keys (expires_at);

CREATE TABLE IF NOT EXISTS global_sequences (
  name VARCHAR(64) PRIMARY KEY,
  last_value BIGINT NOT NULL DEFAULT 0
);

INSERT INTO global_sequences (name, last_value)
VALUES ('tracking', 0)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS shipment_event_log (
  id BIGSERIAL PRIMARY KEY,
  shipment_id UUID NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  event_id VARCHAR(128) NOT NULL,
  sequence_id BIGINT NOT NULL,
  source VARCHAR(32) NOT NULL DEFAULT 'api',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shipment_event_log_event_id_unique UNIQUE (event_id),
  CONSTRAINT shipment_event_log_shipment_seq_unique UNIQUE (shipment_id, sequence_id)
);

CREATE INDEX IF NOT EXISTS shipment_event_log_shipment_seq_idx
  ON shipment_event_log (shipment_id, sequence_id ASC);
