/**
 * Centralized resource authorization — permissions from req.auth.roles[] only.
 * See docs/RBAC.md. Never use activeRole for access decisions.
 */

const { sendError } = require("./apiResponse");

const FORBIDDEN_CODES = {
  FORBIDDEN: "FORBIDDEN",
  FORBIDDEN_ROLE: "FORBIDDEN_ROLE",
  FORBIDDEN_OWNER: "FORBIDDEN_OWNER",
  FORBIDDEN_RESOURCE: "FORBIDDEN_RESOURCE"
};

function hasAdminRole(auth) {
  return (auth?.roles || []).includes("admin");
}

function hasAccountRole(auth, role) {
  return (auth?.roles || []).includes(String(role || "").trim().toLowerCase());
}

function uid(auth) {
  return auth?.userId ? String(auth.userId) : "";
}

/** Standard 403 JSON envelope for authorization failures. */
function sendForbidden(res, message = "Forbidden", code = FORBIDDEN_CODES.FORBIDDEN) {
  return sendError(res, 403, message, null, code);
}

function assertSameUser(auth, ownerId, message = "Forbidden") {
  if (!auth?.userId || String(auth.userId) !== String(ownerId || "")) {
    const err = new Error(message);
    err.statusCode = 403;
    err.code = FORBIDDEN_CODES.FORBIDDEN_OWNER;
    throw err;
  }
}

/**
 * @param {import("express").Response} res
 * @param {object} auth - req.auth
 * @param {string} ownerId
 */
function forbidUnlessOwner(res, auth, ownerId) {
  if (!auth?.userId || String(auth.userId) !== String(ownerId || "")) {
    return sendForbidden(res, "You do not have access to this resource", FORBIDDEN_CODES.FORBIDDEN_OWNER);
  }
  return null;
}

/** Admin moderation only — not for commercial route bypass. */
function forbidUnlessAdmin(res, auth) {
  if (!hasAdminRole(auth)) {
    return sendForbidden(res, "Admin access required", FORBIDDEN_CODES.FORBIDDEN_ROLE);
  }
  return null;
}

/**
 * Read access for a load row (DB or API shape).
 * Carriers: open marketplace loads only, or loads they are assigned to.
 * Shippers: own loads. Admin: all.
 */
function canReadLoad(load, auth) {
  if (!load || !auth?.userId) return false;

  const userId = uid(auth);
  const shipperId = String(load.shipper_id ?? load.shipperId ?? "");
  const carrierId = String(load.assigned_carrier_id ?? load.assignedCarrierId ?? "");
  if (shipperId === userId) return true;
  if (carrierId && carrierId === userId) return true;

  const status = String(load.status || "").toLowerCase();
  if (hasAccountRole(auth, "carrier") && status === "open") return true;
  return false;
}

/** Shipper may update/delete only their own open loads (commercial routes — not admin). */
function canMutateLoadAsShipper(load, auth) {
  if (!load || !auth?.userId) return false;
  if (!hasAccountRole(auth, "shipper")) return false;
  if (String(load.shipper_id ?? load.shipperId) !== uid(auth)) return false;
  return String(load.status || "").toLowerCase() === "open";
}

function canMutateTruck(truck, auth) {
  if (!truck || !auth?.userId) return false;
  return String(truck.user_id ?? truck.userId) === uid(auth);
}

function canMutateCarrierSpaceListing(listing, auth) {
  if (!listing || !auth?.userId) return false;
  return String(listing.carrier_id ?? listing.carrierId) === uid(auth);
}

function canActOnSpaceRequestAsCarrier(row, auth) {
  if (!row || !auth?.userId) return false;
  return String(row.carrier_id ?? row.carrierId) === uid(auth);
}

function canActOnSpaceRequestAsParty(row, auth) {
  if (!row || !auth?.userId) return false;
  const userId = uid(auth);
  return (
    String(row.shipper_id ?? row.shipperId) === userId ||
    String(row.carrier_id ?? row.carrierId) === userId
  );
}

function canAccessConversation(conv, userId) {
  if (!conv || !userId) return false;
  const uidStr = String(userId);
  return String(conv.user_a_id) === uidStr || String(conv.user_b_id) === uidStr;
}

/** Shipment tracking / status: shipper owner or assigned carrier only. */
function canAccessShipmentParties(load, auth) {
  if (!load || !auth?.userId) return false;
  const userId = uid(auth);
  const shipperId = String(load.shipper_id ?? load.shipperId ?? "");
  const carrierId = String(load.assigned_carrier_id ?? load.assignedCarrierId ?? "");
  return shipperId === userId || (carrierId && carrierId === userId);
}

function assertShipmentParties(load, auth) {
  if (!canAccessShipmentParties(load, auth)) {
    const err = new Error("Forbidden");
    err.statusCode = 403;
    err.code = FORBIDDEN_CODES.FORBIDDEN_RESOURCE;
    throw err;
  }
}

function assertAssignedCarrier(load, auth) {
  const assigned = String(load?.assigned_carrier_id ?? load?.assignedCarrierId ?? "");
  if (!assigned || assigned !== uid(auth)) {
    const err = new Error("Only the assigned carrier may perform this action");
    err.statusCode = 403;
    err.code = FORBIDDEN_CODES.FORBIDDEN_OWNER;
    throw err;
  }
}

function canMutateBidAsShipper(bidRow, auth) {
  if (!bidRow || !auth?.userId) return false;
  return String(bidRow.shipper_id ?? bidRow.shipperId) === uid(auth);
}

function canMutateBidAsCarrier(bidRow, auth) {
  if (!bidRow || !auth?.userId) return false;
  return String(bidRow.carrier_id ?? bidRow.carrierId) === uid(auth);
}

/** Strip sensitive fleet fields for public profile viewers. */
function sanitizePublicTrucks(trucks, { viewerId, targetId, hasContract }) {
  const list = Array.isArray(trucks) ? trucks : [];
  const isSelf = viewerId && targetId && String(viewerId) === String(targetId);
  if (isSelf || hasContract) return list;
  return list.map((t) => ({
    id: t.id,
    truckType: t.truckType ?? t.truck_type,
    capacity: t.capacity
  }));
}

module.exports = {
  FORBIDDEN_CODES,
  hasAdminRole,
  hasAccountRole,
  uid,
  sendForbidden,
  assertSameUser,
  forbidUnlessOwner,
  forbidUnlessAdmin,
  canReadLoad,
  canMutateLoadAsShipper,
  canMutateTruck,
  canMutateCarrierSpaceListing,
  canActOnSpaceRequestAsCarrier,
  canActOnSpaceRequestAsParty,
  canAccessConversation,
  canAccessShipmentParties,
  assertShipmentParties,
  assertAssignedCarrier,
  canMutateBidAsShipper,
  canMutateBidAsCarrier,
  sanitizePublicTrucks
};
