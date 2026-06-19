/**
 * Resolve active workspace for notification feed scoping (validated upstream).
 */
function resolveNotificationWorkspace(req) {
  if (req.commercialWorkspace) {
    return req.commercialWorkspace;
  }
  const { resolveCommercialWorkspace } = require("./commercialWorkspace");
  const { workspace } = resolveCommercialWorkspace(req);
  return workspace;
}

module.exports = { resolveNotificationWorkspace };
