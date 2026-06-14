/**
 * Phase 7 — causal validation helpers for tracking writes.
 */
const { query } = require("../db/pool");
const { requiresRedis, isStrictDistributedEnabled } = require("./distributedMode");
const { prepareTrackingEvent } = require("./consistencyEngine");
const { CAUSALITY_TYPES } = require("./causalEventGraph");

function shouldReconstructOrphans() {
  if (String(process.env.CAUSAL_RECONSTRUCT_ORPHANS || "").trim().toLowerCase() === "true") {
    return true;
  }
  return isStrictDistributedEnabled();
}

async function getRecentShipmentEvents(shipmentId, limit = 20) {
  if (!shipmentId) return [];
  try {
    const { rows } = await query(
      `SELECT event_id AS "eventId", sequence_id AS "sequenceId",
              parent_event_id AS "parentEventId", causality_type AS "causalityType"
       FROM shipment_event_log
       WHERE shipment_id = $1
       ORDER BY sequence_id DESC
       LIMIT $2`,
      [shipmentId, Math.min(100, Math.max(1, Number(limit) || 20))]
    );
    return rows.reverse();
  } catch {
    return [];
  }
}

async function validateCausalTrackingEvent({
  shipmentId,
  eventId,
  sequenceId,
  parentEventId,
  causalityType,
  prevSeq = 0,
  fromTrackingState,
  toTrackingState
}) {
  const existingEvents = shipmentId ? await getRecentShipmentEvents(shipmentId, 50) : [];
  const result = prepareTrackingEvent({
    eventId,
    sequenceId,
    parentEventId,
    causalityType: causalityType || CAUSALITY_TYPES.UPDATE,
    existingEvents,
    prevSeq,
    fromTrackingState,
    toTrackingState,
    reconstructOrphans: shouldReconstructOrphans()
  });

  if (!result.ok && requiresRedis() && result.reason === "orphan_event") {
    return { ...result, httpStatus: 422 };
  }

  return result;
}

module.exports = {
  validateCausalTrackingEvent,
  getRecentShipmentEvents,
  shouldReconstructOrphans,
  CAUSALITY_TYPES
};
