const { verifyToken } = require("../utils/jwt");
const { sendError } = require("../utils/apiResponse");
const userRepo = require("../repositories/userRepo");
const { isDemoAdminEmail } = require("../utils/demoAdmin");

async function protect(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const [scheme, token] = auth.split(" ");

    if (scheme !== "Bearer" || !token) {
      return sendError(res, 401, "Unauthorized");
    }

    const decoded = verifyToken(token);
    const userId = decoded?.sub;
    if (!userId) {
      return sendError(res, 401, "Unauthorized");
    }

    const user = await userRepo.findById(userId);
    if (!user) {
      return sendError(res, 401, "Unauthorized");
    }
    if (user.blocked) {
      return sendError(res, 403, "Account is blocked");
    }
    const emailLc = String(user.email || "").trim().toLowerCase();
    if (!user.verified && !isDemoAdminEmail(emailLc)) {
      return sendError(res, 403, "Please verify your email before using the app.", null, "EMAIL_NOT_VERIFIED");
    }

    const roles = Array.isArray(user.roles) ? user.roles : [];
    const dbRole = user.activeRole ? String(user.activeRole).trim().toLowerCase() : null;
    const tokenRole =
      decoded.activeRole != null ? String(decoded.activeRole).trim().toLowerCase() : null;
    const activeRole =
      dbRole || (tokenRole && roles.includes(tokenRole) ? tokenRole : null);

    req.user = user;
    req.auth = {
      userId: String(user.id),
      roles,
      activeRole: activeRole || null
    };

    return next();
  } catch (err) {
    return sendError(res, 401, "Unauthorized");
  }
}

function requireRole(role) {
  return (req, res, next) => {
    const roles = req.auth?.roles || req.user?.roles || [];
    if (!roles.includes(role)) {
      return sendError(res, 403, "Forbidden", null, "FORBIDDEN_ROLE");
    }
    return next();
  };
}

function requireAnyRole(rolesList) {
  const required = Array.isArray(rolesList) ? rolesList : [];
  return (req, res, next) => {
    const roles = req.auth?.roles || req.user?.roles || [];
    if (!required.some((r) => roles.includes(r))) {
      return sendError(res, 403, "Forbidden", null, "FORBIDDEN_ROLE");
    }
    return next();
  };
}

function requireActiveRole(...allowed) {
  const list = allowed.flat();
  return (req, res, next) => {
    const active = req.auth?.activeRole;
    if (list.includes(active)) return next();
    return sendError(res, 403, "Switch role to continue", null, "WRONG_ACTIVE_ROLE");
  };
}

module.exports = {
  protect,
  requireRole,
  requireAnyRole,
  requireActiveRole
};
