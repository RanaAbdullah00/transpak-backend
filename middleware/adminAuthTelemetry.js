const { recordAdminTelemetry } = require("../utils/adminTelemetry");

/** Record admin route auth failures without leaking credentials. */
function adminAuthTelemetry(err, req, res, next) {
  if (err && (err.status === 401 || err.status === 403 || err.statusCode === 401 || err.statusCode === 403)) {
    recordAdminTelemetry({
      widget: "auth",
      event: "auth_failure",
      durationMs: 0,
      ok: false,
      statusCode: err.status || err.statusCode || 403,
      code: err.code != null ? String(err.code) : "FORBIDDEN",
      meta: { path: String(req.originalUrl || "").slice(0, 80) }
    });
  }
  return next(err);
}

module.exports = { adminAuthTelemetry };
