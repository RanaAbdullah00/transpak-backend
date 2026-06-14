/**
 * Phase 6/7 — distributed tracking publish pipeline (sequence + dedupe + causal graph + replay log).
 */
const crypto = require("crypto");
const { buildTrackingUpdatePayload, trackRoomKey } = require("./trackingPayload");
const { nextSequenceId } = require("./sequenceGenerator");
const { claimDistributedEvent } = require("./socketEventDedupe");
const { appendShipmentEventLog, getLastShipmentEvent } = require("./shipmentEventLog");
const { resolveSequenceWinner, mapSourceToTrackingState } = require("./trackingStateMachine");
const { prepareTrackingEvent, resolveConflict, emitCorrectionEvent } = require("./consistencyEngine");
const { validateCausalTrackingEvent } = require("../middleware/causalValidation");
const { recordSpan } = require("./traceStore");
const { recordOrphanDetected } = require("./alertEngine");
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
  parentEventId,
  causalityType,
  extra = {}
}) {
  recordSpan("idempotency_check", { source, shipmentId: shipmentId || null }, shipmentId || null);

  const resolvedEventId = String(eventId || idempotencyKey || newEventId()).slice(0, 128);
  const claimed = await claimDistributedEvent(resolvedEventId);
  if (!claimed) {
    recordDuplicateBlocked();
    return null;
  }

  const sequenceId = await nextSequenceId("tracking");
  recordSpan("sequence_assign", { sequenceId, eventId: resolvedEventId }, shipmentId || null);

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

  const lastEvent = shipmentId ? await getLastShipmentEvent(shipmentId) : null;
  const fromState = lastEvent?.payload?.trackingState || "INIT";
  const toState = mapSourceToTrackingState(source);

  const causal = await validateCausalTrackingEvent({
    shipmentId,
    eventId: resolvedEventId,
    sequenceId,
    parentEventId: parentEventId || lastEvent?.eventId || null,
    causalityType,
    prevSeq,
    fromTrackingState: fromState,
    toTrackingState: toState
  });

  recordSpan("causal_validate", { ok: causal.ok, reason: causal.reason || null }, shipmentId || null);

  if (!causal.ok) {
    if (causal.orphan) {
      await recordOrphanDetected(shipmentId, resolvedEventId);
    }
    return null;
  }

  let node = causal.node;
  if (causal.reconstructed && lastEvent) {
    const conflict = resolveConflict(node, lastEvent);
    node = emitCorrectionEvent({
      winner: conflict.winner,
      loser: conflict.loser,
      reason: causal.reason || "causal_reconstruction",
      payloadExtra: { lat, lng, refKey }
    });
  }

  if (refKey) lastSequenceByRef.set(refKey, Math.max(prevSeq, node.sequenceId || sequenceId));

  payload.sequenceId = node.sequenceId || sequenceId;
  payload.eventId = node.eventId || resolvedEventId;
  payload.parentEventId = node.parentEventId || null;
  payload.causalityType = node.causalityType || causalityType || "UPDATE";
  payload.source = source;
  payload.shipmentId = shipmentId ? String(shipmentId) : payload.shipmentId || null;
  payload.trackingState = toState;

  if (shipmentId) {
    await appendShipmentEventLog({
      shipmentId,
      eventId: payload.eventId,
      sequenceId: payload.sequenceId,
      source,
      payload,
      parentEventId: payload.parentEventId,
      causalityType: payload.causalityType
    });
  }

  recordTrackingEvent();
  recordSpan("redis_publish", { refKey }, shipmentId || null);
  distributedSocketBus.emitTrackingUpdate(payload);
  recordSpan("socket_fanout", { refKey, eventId: payload.eventId }, shipmentId || null);
  return payload;
}

module.exports = {
  publishTrackingEvent,
  newEventId
};
