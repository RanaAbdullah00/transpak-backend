/**
 * Phase 6 — distributed tracking publish pipeline (sequence + dedupe + replay log).
 */
const crypto = require("crypto");
const { buildTrackingUpdatePayload, trackRoomKey } = require("./trackingPayload");
const { nextSequenceId } = require("./sequenceGenerator");
const { claimDistributedEvent } = require("./socketEventDedupe");
const { appendShipmentEventLog } = require("./shipmentEventLog");
const { resolveSequenceWinner } = require("./trackingStateMachine");
const {
  recordTrackingEvent,
  recordReorderCorrection,
  recordDuplicateBlocked
} = require("./metricsCollector");
const distributedSocketBus = require("../services/distributedSocketBus");

const lastSequenceByRef = new Map();

function newEventId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return crypto.randomBytes(16).toString("hex");
}

async function publishTrackingEvent({
  loadId,
  shipmentId,
  lat,
  lng,
  source = "socket",
  eventId,
  idempotencyKey,
  extra = {}
}) {
  const resolvedEventId = String(eventId || idempotencyKey || newEventId()).slice(0, 128);
  const claimed = await claimDistributedEvent(resolvedEventId);
  if (!claimed) {
    recordDuplicateBlocked();
    return null;
  }

  const sequenceId = await nextSequenceId("tracking");
  const payload = await buildTrackingUpdatePayload(loadId, lat, lng, {
    ...extra,
    sequenceId,
    eventId: resolvedEventId,
    source
  });
  if (!payload) return null;

  const refKey = String(payload.refKey || "").trim();
  const prevSeq = lastSequenceByRef.get(refKey) || 0;
  const seqCheck = resolveSequenceWinner(prevSeq, sequenceId);
  if (!seqCheck.accept && seqCheck.reason === "stale_sequence") {
    recordReorderCorrection();
    return null;
  }
  if (refKey) lastSequenceByRef.set(refKey, Math.max(prevSeq, sequenceId));

  payload.sequenceId = sequenceId;
  payload.eventId = resolvedEventId;
  payload.source = source;
  payload.shipmentId = shipmentId ? String(shipmentId) : payload.shipmentId || null;
  payload.trackingState = source === "api" ? "REHYDRATING" : source === "socket" ? "SOCKET_ACTIVE" : "SYNCED";

  if (shipmentId) {
    await appendShipmentEventLog({
      shipmentId,
      eventId: resolvedEventId,
      sequenceId,
      source,
      payload
    });
  }

  recordTrackingEvent();
  distributedSocketBus.emitTrackingUpdate(payload);
  return payload;
}

module.exports = {
  publishTrackingEvent,
  newEventId
};
