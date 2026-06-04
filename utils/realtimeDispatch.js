/**
 * Phase 6 — logistics dispatch event types (socket + notifications).
 */
const crypto = require("crypto");
const {
  emitToUserRole,
  emitToEntityRoom,
  emitToShipment,
  emitToSpace,
  emitToBid
} = require("../services/realtimeHub");
const { recordDispatchFailure } = require("./opsTelemetry");
const { resolveEventType } = require("./eventContractRegistry");

const DISPATCH_TYPES = {
  LOAD_POSTED: "LOAD_POSTED",
  BID_CREATED: "BID_CREATED",
  BID_UPDATED: "BID_UPDATED",
  BID_RECEIVED: "BID_RECEIVED",
  BID_ACCEPTED: "BID_ACCEPTED",
  BID_REJECTED: "BID_REJECTED",
  BID_COUNTER: "BID_COUNTER",
  COUNTER_OFFERED: "COUNTER_OFFERED",
  SHIPPER_CONFIRMATION_REQUEST: "SHIPPER_CONFIRMATION_REQUEST",
  SHIPMENT_STATUS: "SHIPMENT_STATUS",
  TRUCK_APPROVED: "TRUCK_APPROVED",
  TRUCK_REJECTED: "TRUCK_REJECTED",
  TRUCK_SUSPENDED: "TRUCK_SUSPENDED",
  NOTIFICATION: "NOTIFICATION"
};

const ENTITY_EMITTERS = {
  shipment: emitToShipment,
  space: emitToSpace,
  bid: emitToBid
};

function buildDedupeKey(parts) {
  return parts
    .filter((p) => p != null && String(p).length)
    .map((p) => String(p).slice(0, 120))
    .join("|")
    .slice(0, 240);
}

function newEventId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return crypto.randomBytes(16).toString("hex");
}

function buildDispatchRow(envelope) {
  const receiverId = envelope?.receiverId;
  const roleType = envelope?.roleType;
  return {
    eventId: envelope.eventId || newEventId(),
    type: String(envelope.type || DISPATCH_TYPES.NOTIFICATION),
    at: envelope.at || new Date().toISOString(),
    roleType: roleType != null ? String(roleType).toLowerCase() : null,
    scope: receiverId
      ? {
          userId: String(receiverId),
          workspace: String(roleType || "").toLowerCase()
        }
      : null,
    entityType: envelope.entityType || null,
    entityId: envelope.entityId != null ? String(envelope.entityId) : null,
    payload: envelope.payload || null,
    notification: envelope.notification || null
  };
}

function emitEntityFanout(row) {
  const kind = String(row.entityType || "").toLowerCase();
  const id = row.entityId;
  if (!kind || !id) return;
  const fn = ENTITY_EMITTERS[kind] || null;
  if (fn) {
    fn(id, "dispatch:event", row);
    return;
  }
  emitToEntityRoom(kind, id, "dispatch:event", row);
}

function emitDispatchEvent(envelope, attempt = 0) {
  const receiverId = envelope?.receiverId;
  const roleType = envelope?.roleType;
  if (!receiverId || !roleType) return;

  const normalizedType = resolveEventType(envelope?.type);
  const row = buildDispatchRow({ ...envelope, type: normalizedType });

  try {
    emitToUserRole(receiverId, roleType, "dispatch:event", row);
    emitEntityFanout(row);
  } catch (err) {
    recordDispatchFailure(err?.message || "emit_failed");
    if (attempt === 0) {
      setTimeout(() => emitDispatchEvent(envelope, 1), 300);
    }
  }
}

/** Entity-room dispatch without user workspace (subscribers on shipment/space/bid rooms). */
function emitEntityDispatch({ entityType, entityId, type, eventId, payload, at }) {
  if (!entityType || !entityId) return;
  const row = {
    eventId: eventId || newEventId(),
    type: String(type || DISPATCH_TYPES.NOTIFICATION),
    at: at || new Date().toISOString(),
    entityType: String(entityType).toLowerCase(),
    entityId: String(entityId),
    payload: payload || null,
    notification: null
  };
  try {
    emitEntityFanout(row);
  } catch (err) {
    recordDispatchFailure(err?.message || "entity_emit_failed");
    setTimeout(() => {
      try {
        emitEntityFanout(row);
      } catch {
        /* non-blocking retry */
      }
    }, 300);
  }
}

module.exports = {
  DISPATCH_TYPES,
  buildDedupeKey,
  newEventId,
  emitDispatchEvent,
  emitEntityDispatch
};
