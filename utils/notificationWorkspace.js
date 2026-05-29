/**
 * Resolve active workspace for notification feed scoping (Phase 6).
 * Does not replace route authorization — inbox filter only.
 */
function resolveNotificationWorkspace(req) {
  const header = String(req.headers["x-transpak-workspace"] || req.headers["X-TransPak-Workspace"] || "")
    .trim()
    .toLowerCase();
  const query = String(req.query?.workspace || "").trim().toLowerCase();
  const candidate = header || query;
  if (candidate === "shipper" || candidate === "carrier" || candidate === "admin") {
    return candidate;
  }
  return null;
}

module.exports = { resolveNotificationWorkspace };
