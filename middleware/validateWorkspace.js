const { sendError } = require("../utils/apiResponse");
const { resolveCommercialWorkspace } = require("../utils/commercialWorkspace");

/**
 * Resolve and validate commercial workspace for the request.
 * Sets req.commercialWorkspace (shipper|carrier|admin|null).
 */
function validateCommercialWorkspace() {
  return (req, res, next) => {
    const { workspace, error } = resolveCommercialWorkspace(req);
    if (error === "FORBIDDEN_WORKSPACE") {
      return sendError(res, 403, "Forbidden", null, "FORBIDDEN_WORKSPACE");
    }
    if (error === "WORKSPACE_REQUIRED") {
      return sendError(res, 403, "Active workspace required", null, "WORKSPACE_REQUIRED");
    }
    req.commercialWorkspace = workspace;
    return next();
  };
}

/** Route must run in a specific commercial workspace (after validateCommercialWorkspace). */
function requireCommercialWorkspace(role) {
  const required = String(role || "").trim().toLowerCase();
  return (req, res, next) => {
    const ws = String(req.commercialWorkspace || "").trim().toLowerCase();
    if (ws !== required) {
      return sendError(res, 403, "Forbidden", null, "FORBIDDEN_WORKSPACE");
    }
    return next();
  };
}

module.exports = { validateCommercialWorkspace, requireCommercialWorkspace };
