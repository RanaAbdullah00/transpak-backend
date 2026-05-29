const { writeAudit } = require("../utils/auditLog");
const { recordAdminTelemetry } = require("../utils/adminTelemetry");

/**
 * Log admin session activity once per JWT (in-memory; resets on process restart).
 */
const seenSessions = new Set();

function adminSessionAudit(req, res, next) {
  const uid = req.auth?.userId ? String(req.auth.userId) : "";
  if (uid && !seenSessions.has(uid)) {
    seenSessions.add(uid);
    void writeAudit({
      actorUserId: uid,
      action: "admin.session.start",
      targetEntity: "admin",
      targetId: uid,
      metadata: { path: String(req.originalUrl || "").slice(0, 120) }
    });
    recordAdminTelemetry({
      widget: "session",
      event: "admin_session_start",
      durationMs: 0,
      ok: true,
      meta: { userIdSuffix: uid.slice(-6) }
    });
  }
  return next();
}

module.exports = { adminSessionAudit };
