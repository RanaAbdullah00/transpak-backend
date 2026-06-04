const { writeAudit } = require("./auditLog");

function logAdminView(req, action, metadata = {}) {
  if (!req?.auth?.userId) return;
  void writeAudit({
    actorUserId: req.auth.userId,
    action,
    targetEntity: metadata.targetEntity || "admin_view",
    targetId: metadata.targetId || null,
    metadata: { readOnly: true, ...metadata }
  });
}

module.exports = { logAdminView };
