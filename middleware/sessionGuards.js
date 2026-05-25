const { sendError } = require("../utils/apiResponse");

/** Admin moderation APIs require activeRole=admin (not shipper/carrier workspace). */
function requireAdminSession(req, res, next) {
  const roles = req.auth?.roles || req.user?.roles || [];
  if (!roles.includes("admin")) {
    return sendError(res, 403, "Forbidden", null, "FORBIDDEN_ROLE");
  }
  if (req.auth?.activeRole !== "admin") {
    return sendError(
      res,
      403,
      "Switch to admin workspace to use moderation tools",
      null,
      "ADMIN_SESSION_REQUIRED"
    );
  }
  return next();
}

/** Block commercial writes while admin workspace is active (GET maps/reads still allowed). */
function forbidAdminCommercialMutation(req, res, next) {
  if (req.auth?.activeRole !== "admin") return next();
  const method = String(req.method || "GET").toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return next();
  return sendError(
    res,
    403,
    "Commercial actions are disabled in admin workspace",
    null,
    "ADMIN_COMMERCIAL_FORBIDDEN"
  );
}

module.exports = { requireAdminSession, forbidAdminCommercialMutation };
