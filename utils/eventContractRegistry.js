/** Canonical realtime / notification event types (single registry). */
const EVENT_CONTRACT = Object.freeze({
  LOAD_POSTED: "LOAD_POSTED",
  LOAD_ACCEPTED: "LOAD_ACCEPTED",
  LOAD_REJECTED: "LOAD_REJECTED",
  BID_CREATED: "BID_CREATED",
  BID_UPDATED: "BID_UPDATED",
  BID_RECEIVED: "BID_RECEIVED",
  BID_SUGGESTED: "BID_SUGGESTED",
  BID_ACCEPTED: "BID_ACCEPTED",
  BID_REJECTED: "BID_REJECTED",
  BID_COUNTER: "BID_COUNTER",
  COUNTER_OFFERED: "COUNTER_OFFERED",
  CAPACITY_REQUESTED: "CAPACITY_REQUESTED",
  CAPACITY_REQUEST_SENT: "CAPACITY_REQUEST_SENT",
  CAPACITY_ACCEPTED: "CAPACITY_ACCEPTED",
  CAPACITY_REJECTED: "CAPACITY_REJECTED",
  SPACE_REQUEST: "SPACE_REQUEST",
  SPACE_REQUEST_SENT: "SPACE_REQUEST_SENT",
  SPACE_ACCEPTED: "SPACE_ACCEPTED",
  SPACE_REJECTED: "SPACE_REJECTED",
  CONTRACT_STARTED: "CONTRACT_STARTED",
  SHIPMENT_CREATED: "SHIPMENT_CREATED",
  SHIPMENT_STATUS: "SHIPMENT_STATUS",
  SHIPMENT_UPDATED: "SHIPMENT_UPDATED",
  SHIPMENT_PICKED_UP: "SHIPMENT_PICKED_UP",
  SHIPMENT_IN_TRANSIT: "SHIPMENT_IN_TRANSIT",
  SHIPMENT_COMPLETED: "SHIPMENT_COMPLETED",
  DELIVERY_COMPLETED: "DELIVERY_COMPLETED",
  REVIEW_PROMPT: "REVIEW_PROMPT",
  REVIEW_RECEIVED: "REVIEW_RECEIVED",
  SPACE_LISTED: "SPACE_LISTED",
  LOGIN_SUCCESS: "LOGIN_SUCCESS",
  TRUCK_APPROVED: "TRUCK_APPROVED",
  TRUCK_REJECTED: "TRUCK_REJECTED",
  TRUCK_SUSPENDED: "TRUCK_SUSPENDED",
  TRUCK_UPDATED: "TRUCK_UPDATED",
  TRUCK_PENDING: "TRUCK_PENDING",
  VERIFICATION_APPROVED: "VERIFICATION_APPROVED",
  VERIFICATION_REJECTED: "VERIFICATION_REJECTED",
  SHIPPER_CONFIRMATION_REQUEST: "SHIPPER_CONFIRMATION_REQUEST",
  NOTIFICATION: "NOTIFICATION"
});

const ALIASES = Object.freeze({
  SPACE_UPDATE: "SHIPMENT_UPDATED",
  SPACE_IN_TRANSIT: "SHIPMENT_IN_TRANSIT",
  SPACE_COMPLETED: "SHIPMENT_COMPLETED"
});

const ALLOWED = new Set([...Object.values(EVENT_CONTRACT), ...Object.keys(ALIASES)]);

function normalizeEventType(raw) {
  const key = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
  if (!key) return EVENT_CONTRACT.NOTIFICATION;
  if (EVENT_CONTRACT[key]) return EVENT_CONTRACT[key];
  if (ALIASES[key]) return ALIASES[key];
  return null;
}

function resolveEventType(raw) {
  return normalizeEventType(raw) || EVENT_CONTRACT.NOTIFICATION;
}

function assertEventType(raw) {
  const normalized = normalizeEventType(raw);
  if (!normalized) {
    const err = new Error(`Unknown event type: ${raw}`);
    err.code = "INVALID_EVENT_TYPE";
    throw err;
  }
  return normalized;
}

/** Validated dispatch to user workspace (notifications + list refresh). */
function emitContractDispatch(envelope) {
  const { emitDispatchEvent, newEventId } = require("./realtimeDispatch");
  const type = assertEventType(envelope?.type);
  emitDispatchEvent({
    ...envelope,
    type,
    eventId: envelope?.eventId || newEventId()
  });
}

/** Validated entity-room fanout (tracking / space / bid rooms). */
function emitContractEntityDispatch({ entityType, entityId, type, eventId, payload, at }) {
  const { emitEntityDispatch, newEventId } = require("./realtimeDispatch");
  const normalized = assertEventType(type);
  emitEntityDispatch({
    entityType,
    entityId,
    type: normalized,
    eventId: eventId || newEventId(),
    payload: payload || null,
    at
  });
}

module.exports = {
  EVENT_CONTRACT,
  normalizeEventType,
  resolveEventType,
  assertEventType,
  emitContractDispatch,
  emitContractEntityDispatch
};
