const { sendForbidden, FORBIDDEN_CODES, hasAdminRole } = require("../utils/resourceAuth");

/**
 * Platform-only admin accounts must use /api/admin/* — block marketplace APIs.
 */
function forbidAdminOnlyCommercial(req, res, next) {
  const roles = req.auth?.roles || [];
  const commercial = roles.filter((r) => r === "shipper" || r === "carrier");
  if (hasAdminRole(req.auth) && commercial.length === 0) {
    return sendForbidden(
      res,
      "Platform admin accounts cannot use marketplace APIs",
      FORBIDDEN_CODES.FORBIDDEN_ROLE
    );
  }
  return next();
}

module.exports = { forbidAdminOnlyCommercial };
