/**
 * Phase 6/7 — authoritative shipment event replay log with causal fields.
 */
const { query } = require("../db/pool");

async function appendShipmentEventLog({
  shipmentId,
  eventId,
  sequenceId,
  source,
  payload,
  parentEventId = null,
  causalityType = "CREATE"
}) {
  if (!shipmentId || !eventId) return null;
  try {
    const { rows } = await query(
      `INSERT INTO shipment_event_log
         (shipment_id, event_id, sequence_id, source, payload, parent_event_id, causality_type)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING id, shipment_id AS "shipmentId", event_id AS "eventId",
                 sequence_id AS "sequenceId", source, payload,
                 parent_event_id AS "parentEventId", causality_type AS "causalityType",
                 created_at AS "createdAt"`,
      [
        shipmentId,
        String(eventId).slice(0, 128),
        Number(sequenceId) || 0,
        String(source || "api").slice(0, 32),
        JSON.stringify(payload || {}),
        parentEventId ? String(parentEventId).slice(0, 128) : null,
        String(causalityType || "CREATE").slice(0, 16)
      ]
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}

async function getShipmentReplayEvents(shipmentId, { limit = 500 } = {}) {
  const cap = Math.min(1000, Math.max(1, Number(limit) || 500));
  try {
    const { rows } = await query(
      `SELECT event_id AS "eventId", sequence_id AS "sequenceId", source,
              parent_event_id AS "parentEventId", causality_type AS "causalityType",
              payload, created_at AS "timestamp"
       FROM shipment_event_log
       WHERE shipment_id = $1
       ORDER BY sequence_id ASC, created_at ASC
       LIMIT $2`,
      [shipmentId, cap]
    );
    return rows;
  } catch {
    return [];
  }
}

async function getLastShipmentEvent(shipmentId) {
  if (!shipmentId) return null;
  try {
    const { rows } = await query(
      `SELECT event_id AS "eventId", sequence_id AS "sequenceId",
              parent_event_id AS "parentEventId", causality_type AS "causalityType"
       FROM shipment_event_log
       WHERE shipment_id = $1
       ORDER BY sequence_id DESC
       LIMIT 1`,
      [shipmentId]
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}

module.exports = {
  appendShipmentEventLog,
  getShipmentReplayEvents,
  getLastShipmentEvent
};
