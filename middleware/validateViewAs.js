const { sendError } = require("../utils/apiResponse");
const { normalizeCommercialView } = require("../utils/commercialViewRole");

/**
 * Reject ?viewAs= unless value is shipper|carrier AND present in req.auth.roles[].
 * Sets req.commercialView (validated) or null when param omitted.
 */
function validateViewAs() {
  return (req, res, next) => {
    const raw = req.query?.viewAs;
    if (raw == null || String(raw).trim() === "") {
      req.commercialView = null;
      return next();
    }

    const viewAs = normalizeCommercialView(raw);
    if (!viewAs) {
      return sendError(res, 400, "Invalid viewAs parameter", null, "INVALID_VIEW_AS");
    }

    const roles = req.auth?.roles || [];
    if (!roles.includes(viewAs)) {
      return sendError(res, 403, "Forbidden", null, "FORBIDDEN_VIEW_AS");
    }

    req.commercialView = viewAs;
    return next();
  };
}

module.exports = { validateViewAs };
