const { verifyToken } = require("../utils/jwt");
const { sendError } = require("../utils/apiResponse");
const userRepo = require("../repositories/userRepo");
const { isDemoAdminEmail } = require("../utils/demoAdmin");
const { buildAuthContextFromDB, logAuthContext } = require("../utils/authContext");

/** Valid JWT identity → load permissions from DB only. */
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const [scheme, token] = authHeader.split(" ");

    if (scheme !== "Bearer" || !token) {
      return sendError(res, 401, "Unauthorized");
    }

    let decoded;
    try {
      decoded = verifyToken(token);
    } catch {
      return sendError(res, 401, "Unauthorized");
    }

    const userId = decoded?.sub;
    if (!userId) {
      return sendError(res, 401, "Unauthorized");
    }

    const ctx = await buildAuthContextFromDB(userId);
    if (!ctx?.user) {
      return sendError(res, 401, "Unauthorized");
    }

    const user = ctx.user;
    if (user.blocked) {
      return sendError(res, 403, "Account is blocked");
    }
    const emailLc = String(user.email || "").trim().toLowerCase();
    if (!user.verified && !isDemoAdminEmail(emailLc)) {
      return sendError(res, 403, "Please verify your email before using the app.", null, "EMAIL_NOT_VERIFIED");
    }

    req.user = user;
    req.auth = ctx;
    logAuthContext(req, ctx);

    return next();
  } catch (err) {
    return sendError(res, 401, "Unauthorized");
  }
}

/** Account must include role in DB roles[] (authorization only — see docs/RBAC.md). */
function requireRole(role) {
  const required = String(role || "").trim().toLowerCase();
  return (req, res, next) => {
    const roles = req.auth?.roles || [];
    if (!roles.includes(required)) {
      return sendError(res, 403, "Forbidden", null, "FORBIDDEN_ROLE");
    }
    return next();
  };
}

/** Account must include at least one role from the list (DB roles[] only). */
function requireAnyRole(rolesList) {
  const required = (Array.isArray(rolesList) ? rolesList : []).map((r) =>
    String(r).trim().toLowerCase()
  );
  return (req, res, next) => {
    const roles = req.auth?.roles || [];
    if (!required.some((r) => roles.includes(r))) {
      return sendError(res, 403, "Forbidden", null, "FORBIDDEN_ROLE");
    }
    return next();
  };
}

const protect = requireAuth;

const { validateViewAs } = require("./validateViewAs");

module.exports = {
  requireAuth,
  protect,
  requireRole,
  requireAnyRole,
  validateViewAs
};
