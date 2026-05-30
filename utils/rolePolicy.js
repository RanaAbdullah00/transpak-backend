/**
 * Single-role storage policy — backend is authoritative (no dual commercial, admin isolated).
 */
const { normalizeRole, hasRole } = require("./roleConstants");

function commercialOnly(roles) {
  return (Array.isArray(roles) ? roles : [])
    .map((r) => normalizeRole(r))
    .filter((r) => r === "shipper" || r === "carrier");
}

/**
 * Normalize roles[] for DB storage / API.
 * - Admin accounts: roles = ['admin'] only
 * - Commercial: exactly one of shipper | carrier
 */
function sanitizeRolesForStorage(roles, activeRole = null) {
  const raw = Array.isArray(roles) ? roles : [];
  const normalized = [...new Set(raw.map((r) => normalizeRole(r)).filter(Boolean))];

  if (normalized.includes("admin")) {
    return { roles: ["admin"], activeRole: "admin", ok: true };
  }

  const commercial = commercialOnly(normalized);
  if (!commercial.length) {
    const fallback = normalizeRole(activeRole) || "shipper";
    return { roles: [fallback], activeRole: fallback, ok: true };
  }

  const active = normalizeRole(activeRole);
  const chosen = commercial.includes(active) ? active : commercial[0];
  return { roles: [chosen], activeRole: chosen, ok: true };
}

/** Reject illegal role mutations (dual commercial, admin + commercial, role switching). */
function validateRoleMutation(user, nextActiveRole, nextRoles = null) {
  if (!user) return { ok: false, code: "UNAUTHORIZED", message: "Unauthorized" };

  const current = sanitizeRolesForStorage(user.roles, user.activeRole);
  const proposedRoles = nextRoles != null ? nextRoles : current.roles;
  const proposedActive = nextActiveRole != null ? nextActiveRole : user.activeRole;
  const target = sanitizeRolesForStorage(proposedRoles, proposedActive);

  if (hasRole(user, "admin")) {
    if (target.activeRole !== "admin" || !target.roles.every((r) => r === "admin")) {
      return {
        ok: false,
        code: "ADMIN_ROLE_LOCKED",
        message: "Admin accounts cannot use shipper or carrier roles"
      };
    }
    if (nextActiveRole && normalizeRole(nextActiveRole) !== user.activeRole) {
      return { ok: false, code: "ROLE_SWITCH_DISABLED", message: "Role switching is disabled" };
    }
    return { ok: true, ...target };
  }

  if (nextRoles != null) {
    const incomingCommercial = commercialOnly(nextRoles);
    if (incomingCommercial.length > 1) {
      return { ok: false, code: "DUAL_ROLE_FORBIDDEN", message: "Accounts may only have one commercial role" };
    }
    if (nextRoles.includes("admin")) {
      return { ok: false, code: "INVALID_ROLE", message: "Cannot assign admin role through this endpoint" };
    }
  }

  if (nextActiveRole && normalizeRole(nextActiveRole) !== normalizeRole(user.activeRole)) {
    return { ok: false, code: "ROLE_SWITCH_DISABLED", message: "Role switching is disabled" };
  }

  return { ok: true, ...target };
}

function validateAddRole(user, role) {
  const r = normalizeRole(role);
  if (!r || r === "admin") {
    return { ok: false, code: "INVALID_ROLE", message: "Invalid role" };
  }
  if (hasRole(user, "admin")) {
    return { ok: false, code: "ADMIN_ROLE_LOCKED", message: "Admin accounts cannot add commercial roles" };
  }
  if (hasRole(user, r)) {
    return { ok: true, already: true };
  }
  const commercial = commercialOnly(user.roles);
  if (commercial.length >= 1) {
    return { ok: false, code: "ROLE_ADD_DISABLED", message: "Adding a second role is disabled" };
  }
  return { ok: true };
}

module.exports = {
  sanitizeRolesForStorage,
  validateRoleMutation,
  validateAddRole,
  commercialOnly
};
