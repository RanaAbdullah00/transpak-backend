/**
 * Phase 7 — trace span store (ring buffer + optional DB persistence).
 */
const { query } = require("../db/pool");
const { getTraceId } = require("./traceContext");

const RING_MAX = Number(process.env.TRACE_RING_MAX || 5000);
const TTL_DAYS = Number(process.env.TRACE_SPAN_TTL_DAYS || 7);

/** @type {Map<string, object[]>} */
const ring = new Map();

const SPAN_NAMES = Object.freeze([
  "request_start",
  "idempotency_check",
  "sequence_assign",
  "causal_validate",
  "redis_publish",
  "socket_fanout",
  "client_apply"
]);

function pushRing(traceId, span) {
  const key = String(traceId || "").slice(0, 64);
  if (!key) return;
  let list = ring.get(key);
  if (!list) {
    list = [];
    ring.set(key, list);
  }
  list.push(span);
  if (list.length > 200) list.shift();
  if (ring.size > RING_MAX) {
    const first = ring.keys().next().value;
    if (first) ring.delete(first);
  }
}

async function persistSpan({ traceId, spanName, shipmentId = null, metadata = {} }) {
  const tid = String(traceId || getTraceId() || "").slice(0, 64);
  const name = String(spanName || "").slice(0, 64);
  if (!tid || !name) return null;

  const span = {
    traceId: tid,
    spanName: name,
    shipmentId: shipmentId || null,
    metadata,
    createdAt: new Date().toISOString()
  };
  pushRing(tid, span);

  try {
    await query(
      `INSERT INTO trace_spans (trace_id, span_name, shipment_id, metadata)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [tid, name, shipmentId || null, JSON.stringify(metadata || {})]
    );
  } catch {
    /* DB optional during boot / tests */
  }
  return span;
}

function recordSpan(spanName, metadata = {}, shipmentId = null) {
  const traceId = getTraceId();
  if (!traceId) return null;
  persistSpan({ traceId, spanName, shipmentId, metadata }).catch(() => {});
  return { traceId, spanName };
}

async function getTraceById(traceId) {
  const tid = String(traceId || "").slice(0, 64);
  if (!tid) return { traceId: tid, spans: [] };

  const mem = ring.get(tid) || [];
  try {
    const { rows } = await query(
      `SELECT trace_id AS "traceId", span_name AS "spanName", shipment_id AS "shipmentId",
              metadata, created_at AS "createdAt"
       FROM trace_spans
       WHERE trace_id = $1
       ORDER BY created_at ASC
       LIMIT 500`,
      [tid]
    );
    if (rows.length) {
      return { traceId: tid, spans: mem.length > rows.length ? mem : rows };
    }
  } catch {
    /* fall through */
  }
  return { traceId: tid, spans: mem };
}

async function getTracesByShipment(shipmentId, { limit = 100 } = {}) {
  if (!shipmentId) return { shipmentId, traces: [] };
  try {
    const { rows } = await query(
      `SELECT trace_id AS "traceId", span_name AS "spanName", metadata, created_at AS "createdAt"
       FROM trace_spans
       WHERE shipment_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [shipmentId, Math.min(500, Math.max(1, Number(limit) || 100))]
    );
    const grouped = {};
    for (const row of rows) {
      grouped[row.traceId] = grouped[row.traceId] || { traceId: row.traceId, spans: [] };
      grouped[row.traceId].spans.unshift(row);
    }
    return { shipmentId, traces: Object.values(grouped) };
  } catch {
    return { shipmentId, traces: [] };
  }
}

async function pruneOldSpans() {
  if (TTL_DAYS <= 0) return;
  try {
    await query(`DELETE FROM trace_spans WHERE created_at < now() - ($1 || ' days')::interval`, [
      String(TTL_DAYS)
    ]);
  } catch {
    /* ignore */
  }
}

module.exports = {
  SPAN_NAMES,
  recordSpan,
  persistSpan,
  getTraceById,
  getTracesByShipment,
  pruneOldSpans
};
