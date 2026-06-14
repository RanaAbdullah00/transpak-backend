/**
 * Phase 6 — authoritative shipment event replay log.
 */
const { query } = require("../db/pool");

async function appendShipmentEventLog({ shipmentId, eventId, sequenceId, source, payload }) {
  if (!shipmentId || !eventId) return null;
  try {
    const { rows } = await query(
      `INSERT INTO shipment_event_log (shipment_id, event_id, sequence_id, source, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING id, shipment_id AS "shipmentId", event_id AS "eventId",
                 sequence_id AS "sequenceId", source, payload, created_at AS "createdAt"`,
      [
        shipmentId,
        String(eventId).slice(0, 128),
        Number(sequenceId) || 0,
        String(source || "api").slice(0, 32),
        JSON.stringify(payload || {})
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

module.exports = {
  appendShipmentEventLog,
  getShipmentReplayEvents
};
