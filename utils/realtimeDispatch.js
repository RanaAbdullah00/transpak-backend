/**
 * Phase 6 — logistics dispatch event types (socket + notifications).
 */
const crypto = require("crypto");
const { emitToUserRole } = require("../services/realtimeHub");
const { recordDispatchFailure } = require("./opsTelemetry");

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

/**
 * @param {object} envelope
 * @param {string} envelope.eventId
 * @param {string} envelope.type
 * @param {string} envelope.receiverId
 * @param {string|null} envelope.roleType
 * @param {object} [envelope.payload]
 * @param {object} [envelope.notification]
 */
function emitDispatchEvent(envelope) {
  const receiverId = envelope?.receiverId;
  const roleType = envelope?.roleType;
  if (!receiverId || !roleType) return;

  const row = {
    eventId: envelope.eventId || newEventId(),
    type: String(envelope.type || DISPATCH_TYPES.NOTIFICATION),
    at: envelope.at || new Date().toISOString(),
    roleType: String(roleType).toLowerCase(),
    scope: {
      userId: String(receiverId),
      workspace: String(roleType).toLowerCase()
    },
    payload: envelope.payload || null,
    notification: envelope.notification || null
  };

  try {
    emitToUserRole(receiverId, roleType, "dispatch:event", row);
  } catch (err) {
    recordDispatchFailure(err?.message || "emit_failed");
  }
}

module.exports = {
  DISPATCH_TYPES,
  buildDedupeKey,
  newEventId,
  emitDispatchEvent
};
