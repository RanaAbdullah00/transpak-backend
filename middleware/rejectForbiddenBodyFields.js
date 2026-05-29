const { sendError } = require("../utils/apiResponse");

/** Keys that must never be set via client request bodies (mass-assignment / privilege escalation). */
const FORBIDDEN_BODY_KEYS = new Set([
  "user_id",
  "userid",
  "receiver_id",
  "receiverid",
  "sender_id",
  "senderid",
  "shipper_id",
  "shipperid",
  "carrier_id",
  "carrierid",
  "assigned_carrier_id",
  "assignedcarrierid",
  "owner_id",
  "ownerid",
  "roles",
  "role",
  "active_role",
  "activerole",
  "activeRole",
  "blocked",
  "verified",
  "is_admin",
  "isadmin",
  "admin",
  "password_hash",
  "passwordhash",
  "is_profile_complete",
  "isprofilecomplete",
  "accepted_bid_id",
  "acceptedbidid",
  "status"
]);

function normalizeBodyKey(key) {
  return String(key || "")
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

/** Paths that may send otherwise-forbidden keys (still validated by route handlers). */
function allowedKeysForPath(req) {
  const url = String(req.originalUrl || req.path || "").split("?")[0];
  if (/^\/api\/admin\b/i.test(url)) return null;
  if (/\/api\/auth\/active-role$/i.test(url)) return new Set(["active_role", "activerole", "activeRole"]);
  if (/\/api\/auth\/add-role$/i.test(url)) return new Set(["role"]);
  if (/\/api\/auth\/register$/i.test(url)) return new Set(["role"]);
  if (/\/api\/shipments\/[^/]+\/status$/i.test(url)) return new Set(["status"]);
  if (
    /\/api\/carrier-space\/listings\/[^/]+$/i.test(url) &&
    String(req.method || "").toUpperCase() === "PATCH"
  ) {
    return new Set(["status"]);
  }
  return new Set();
}

/**
 * Reject privileged fields on mutating API requests (POST/PUT/PATCH).
 */
function rejectForbiddenBodyFields(req, res, next) {
  const method = String(req.method || "").toUpperCase();
  if (!["POST", "PUT", "PATCH"].includes(method)) return next();

  const pathAllow = allowedKeysForPath(req);
  if (pathAllow === null) return next();

  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return next();

  for (const key of Object.keys(body)) {
    const norm = normalizeBodyKey(key);
    if (pathAllow.has(norm) || pathAllow.has(key)) continue;
    if (FORBIDDEN_BODY_KEYS.has(norm) || FORBIDDEN_BODY_KEYS.has(key)) {
      return sendError(res, 400, `Field not allowed: ${key}`, null, "FORBIDDEN_FIELD");
    }
  }
  return next();
}

module.exports = { rejectForbiddenBodyFields, FORBIDDEN_BODY_KEYS };
