/**
 * RBAC contract (see docs/RBAC.md):
 * - roles[] = permission checks (requireRole)
 * - active_role on user row = persisted UI workspace; returned on user object only
 * - JWT sub = identity; role fields in JWT are not used for authorization
 */

const userRepo = require("../repositories/userRepo");

function normalizeRole(value) {
  const r = String(value || "").trim().toLowerCase();
  return r || null;
}

function normalizeRoles(roles) {
  return Array.isArray(roles) ? roles.map((r) => normalizeRole(r)).filter(Boolean) : [];
}

/**
 * Build req.auth from a DB user row (sync).
 * @param {object} user
 * @returns {{ user: object, userId: string, roles: string[] }}
 */
function buildAuthContext(user) {
  if (!user) return null;
  const roles = normalizeRoles(user.roles);
  return {
    user,
    userId: String(user.id),
    roles
  };
}

/**
 * Load user from DB and build auth context (single entry point).
 * @param {string} userId
 */
async function buildAuthContextFromDB(userId) {
  const user = await userRepo.findById(userId);
  if (!user) return null;
  return buildAuthContext(user);
}

function isAuthDebugEnabled() {
  return String(process.env.AUTH_DEBUG || "").trim().toLowerCase() === "true";
}

function logAuthContext(req, ctx, extra = {}) {
  if (!isAuthDebugEnabled() || !ctx) return;
  // eslint-disable-next-line no-console
  console.log("[auth.context]", {
    path: `${req.method} ${req.originalUrl}`,
    userId: ctx.userId,
    dbRoles: ctx.roles,
    dbActiveRole: ctx.user?.activeRole ?? null,
    ...extra
  });
}

module.exports = {
  buildAuthContext,
  buildAuthContextFromDB,
  logAuthContext,
  isAuthDebugEnabled,
  normalizeRole,
  normalizeRoles
};
