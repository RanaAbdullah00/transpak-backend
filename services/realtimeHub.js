const { entityRoom } = require("../utils/entityRooms");

/** Socket.io instance injected at server bootstrap (avoids circular requires). */
let io = null;

function setIO(instance) {
  io = instance;
}

function workspaceRoom(userId, role) {
  const r = String(role || "").trim().toLowerCase();
  const uid = String(userId || "");
  if (!uid || !r) return null;
  if (!["shipper", "carrier", "admin"].includes(r)) return null;
  return `user:${uid}:role:${r}`;
}

/**
 * Emit to role-scoped workspace channel (Phase 2 isolation).
 */
function emitToUserRole(userId, roleType, event, payload) {
  if (!io || !userId) return;
  const room = workspaceRoom(userId, roleType);
  if (!room) return;
  try {
    io.to(room).emit(event, payload);
  } catch {
    // ignore emit failures
  }
}

/** Emit to all commercial role rooms for a user (e.g. chat while peer may be on either workspace). */
async function emitToUserCommercialRoles(userId, event, payload, queryFn) {
  if (!io || !userId) return;
  let roles = [];
  if (typeof queryFn === "function") {
    try {
      const { rows } = await queryFn(
        `SELECT roles FROM users WHERE id = $1`,
        [userId]
      );
      roles = Array.isArray(rows[0]?.roles) ? rows[0].roles : [];
    } catch {
      roles = [];
    }
  }
  const commercial = roles.filter((r) => r === "shipper" || r === "carrier");
  if (!commercial.length) {
    emitToUserRole(userId, "admin", event, payload);
    return;
  }
  commercial.forEach((r) => emitToUserRole(userId, r, event, payload));
}

/** @deprecated Prefer emitToUserRole — kept for non-notification paths during migration. */
function emitToUser(userId, event, payload, roleType = null) {
  if (roleType) {
    emitToUserRole(userId, roleType, event, payload);
    return;
  }
  if (!io || !userId) return;
  try {
    io.to(`user:${String(userId)}`).emit(event, payload);
  } catch {
    // ignore emit failures
  }
}

function emitToConversation(conversationId, event, payload) {
  if (!io || !conversationId) return;
  try {
    io.to(`conv:${String(conversationId)}`).emit(event, payload);
  } catch {
    // ignore
  }
}

function getIO() {
  return io;
}

function getConnectedSocketCount() {
  if (!io) return 0;
  try {
    if (typeof io.engine?.clientsCount === "number") return io.engine.clientsCount;
    if (io.sockets?.sockets?.size != null) return io.sockets.sockets.size;
  } catch {
    // ignore
  }
  return 0;
}

function isEngineReady() {
  return Boolean(io && io.engine);
}

function emitToTracking(refKey, event, payload) {
  if (!io || !refKey) return;
  const key = String(refKey);
  try {
    io.to(`track:${key}`).emit(event, payload);
  } catch {
    // ignore
  }
}

/** Entity-scoped room (shipment|space|bid|track) — same room for all parties. */
function emitToEntityRoom(kind, entityId, event, payload) {
  const room = entityRoom(kind, entityId);
  if (!io || !room) return false;
  try {
    io.to(room).emit(event, payload);
    return true;
  } catch {
    return false;
  }
}

function emitToShipment(shipmentId, event, payload) {
  return emitToEntityRoom("shipment", shipmentId, event, payload);
}

function emitToSpace(requestId, event, payload) {
  return emitToEntityRoom("space", requestId, event, payload);
}

function emitToBid(bidId, event, payload) {
  return emitToEntityRoom("bid", bidId, event, payload);
}

module.exports = {
  setIO,
  getIO,
  getConnectedSocketCount,
  isEngineReady,
  workspaceRoom,
  emitToUser,
  emitToUserRole,
  emitToUserCommercialRoles,
  emitToConversation,
  emitToTracking,
  emitToEntityRoom,
  emitToShipment,
  emitToSpace,
  emitToBid
};
