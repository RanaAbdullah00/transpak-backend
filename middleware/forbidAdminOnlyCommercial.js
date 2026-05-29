const { sendForbidden, FORBIDDEN_CODES, hasAdminRole } = require("../utils/resourceAuth");

/** Routes platform-only admins may use (not marketplace). */
const ADMIN_ALLOWED_BASES = ["/api/profile", "/api/notifications", "/api/auth"];

function isAllowedForPlatformAdmin(req) {
  const base = String(req.baseUrl || "");
  const original = String(req.originalUrl || "");
  return ADMIN_ALLOWED_BASES.some((p) => base === p || base.startsWith(p) || original.startsWith(p));
}

/**
 * Platform-only admin accounts must use /api/admin/* — block marketplace APIs.
 */
function forbidAdminOnlyCommercial(req, res, next) {
  const roles = req.auth?.roles || [];
  const commercial = roles.filter((r) => r === "shipper" || r === "carrier");
  if (!hasAdminRole(req.auth) || commercial.length > 0) {
    return next();
  }
  if (isAllowedForPlatformAdmin(req)) {
    return next();
  }
  return sendForbidden(
    res,
    "Platform admin accounts cannot use marketplace APIs",
    FORBIDDEN_CODES.FORBIDDEN_ROLE
  );
}

module.exports = { forbidAdminOnlyCommercial };
