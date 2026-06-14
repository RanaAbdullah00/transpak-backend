-- Phase 7 — causal event graph, distributed tracing, alerting

ALTER TABLE shipment_event_log
  ADD COLUMN IF NOT EXISTS parent_event_id VARCHAR(128),
  ADD COLUMN IF NOT EXISTS causality_type VARCHAR(16) NOT NULL DEFAULT 'CREATE';

CREATE INDEX IF NOT EXISTS shipment_event_log_parent_idx
  ON shipment_event_log (shipment_id, parent_event_id);

CREATE INDEX IF NOT EXISTS shipment_event_log_causality_idx
  ON shipment_event_log (shipment_id, causality_type);

CREATE TABLE IF NOT EXISTS trace_spans (
  id BIGSERIAL PRIMARY KEY,
  trace_id VARCHAR(64) NOT NULL,
  span_name VARCHAR(64) NOT NULL,
  shipment_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trace_spans_trace_id_idx
  ON trace_spans (trace_id, created_at ASC);

CREATE INDEX IF NOT EXISTS trace_spans_shipment_idx
  ON trace_spans (shipment_id, created_at DESC)
  WHERE shipment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS system_alerts (
  id BIGSERIAL PRIMARY KEY,
  severity VARCHAR(16) NOT NULL DEFAULT 'INFO',
  code VARCHAR(64) NOT NULL,
  message TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS system_alerts_created_idx
  ON system_alerts (created_at DESC);

CREATE INDEX IF NOT EXISTS system_alerts_severity_idx
  ON system_alerts (severity, created_at DESC);
