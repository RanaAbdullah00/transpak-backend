const { verifyToken } = require("../utils/jwt");
const { sendError } = require("../utils/apiResponse");
const userRepo = require("../repositories/userRepo");

const DEMO_FORCE_ADMIN_EMAIL = "mrabdullah0456@gmail.com";

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
    if (!user.verified && emailLc !== DEMO_FORCE_ADMIN_EMAIL) {
      return sendError(res, 403, "Please verify your email before using the app.", null, "EMAIL_NOT_VERIFIED");
    }

    req.user = user;
    req.auth = {
      userId: String(user.id),
      roles: Array.isArray(user.roles) ? user.roles : [],
      activeRole: user.activeRole || null
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
      return sendError(res, 403, "Forbidden");
    }
    return next();
  };
}

function requireAnyRole(rolesList) {
  const required = Array.isArray(rolesList) ? rolesList : [];
  return (req, res, next) => {
    const roles = req.auth?.roles || req.user?.roles || [];
    if (!required.some((r) => roles.includes(r))) {
      return sendError(res, 403, "Forbidden");
    }
    return next();
  };
}

function requireActiveRole(...allowed) {
  const list = allowed.flat();
  return (req, res, next) => {
    const roles = req.auth?.roles || [];
    if (roles.includes("admin")) return next();
    const active = req.auth?.activeRole;
    if (list.includes(active)) return next();
    return sendError(res, 403, "Switch role to continue");
  };
}

module.exports = {
  protect,
  requireRole,
  requireAnyRole,
  requireActiveRole
};
