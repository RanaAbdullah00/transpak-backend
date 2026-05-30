/**
 * Role storage policy — admin isolated; commercial users may hold shipper + carrier.
 */
const { normalizeRole, hasRole } = require("./roleConstants");

function commercialOnly(roles) {
  const out = [];
  for (const r of Array.isArray(roles) ? roles : []) {
    const n = normalizeRole(r);
    if ((n === "shipper" || n === "carrier") && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Normalize roles[] for DB storage / API.
 * - Admin accounts: roles = ['admin'] only (never mixed with commercial)
 * - Commercial: shipper and/or carrier (max two)
 */
function sanitizeRolesForStorage(roles, activeRole = null) {
  const normalized = [...new Set((Array.isArray(roles) ? roles : []).map((r) => normalizeRole(r)).filter(Boolean))];

  if (normalized.includes("admin")) {
    return { roles: ["admin"], activeRole: "admin", ok: true };
  }

  const commercial = commercialOnly(normalized);
  if (!commercial.length) {
    const fallback = normalizeRole(activeRole) || "shipper";
    return { roles: [fallback], activeRole: fallback, ok: true };
  }

  const active = normalizeRole(activeRole);
  const chosenActive = commercial.includes(active) ? active : commercial[0];
  return { roles: commercial, activeRole: chosenActive, ok: true };
}

/** Reject illegal role mutations (admin + commercial, invalid admin switch). */
function validateRoleMutation(user, nextActiveRole, nextRoles = null) {
  if (!user) return { ok: false, code: "UNAUTHORIZED", message: "Unauthorized" };

  if (hasRole(user, "admin")) {
    if (nextRoles != null) {
      const nonAdmin = (Array.isArray(nextRoles) ? nextRoles : [])
        .map((r) => normalizeRole(r))
        .filter((r) => r && r !== "admin");
      if (nonAdmin.length) {
        return {
          ok: false,
          code: "ADMIN_ROLE_LOCKED",
          message: "Admin accounts cannot use shipper or carrier roles"
        };
      }
    }
    if (nextActiveRole && normalizeRole(nextActiveRole) !== "admin") {
      return {
        ok: false,
        code: "ADMIN_ROLE_LOCKED",
        message: "Admin accounts cannot use shipper or carrier roles"
      };
    }
    return { ok: true, roles: ["admin"], activeRole: "admin" };
  }

  const current = sanitizeRolesForStorage(user.roles, user.activeRole);

  if (nextRoles != null) {
    if ((Array.isArray(nextRoles) ? nextRoles : []).some((r) => normalizeRole(r) === "admin")) {
      return { ok: false, code: "INVALID_ROLE", message: "Cannot assign admin role through this endpoint" };
    }
    const incomingCommercial = commercialOnly(nextRoles);
    if (incomingCommercial.length > 2) {
      return { ok: false, code: "DUAL_ROLE_FORBIDDEN", message: "At most two commercial roles allowed" };
    }
    const target = sanitizeRolesForStorage(nextRoles, nextActiveRole ?? user.activeRole);
    return { ok: true, ...target };
  }

  const next = normalizeRole(nextActiveRole);
  if (next && next !== normalizeRole(user.activeRole)) {
    if (!current.roles.includes(next)) {
      return { ok: false, code: "ROLE_NOT_GRANTED", message: "Role not available for this account" };
    }
    return { ok: true, roles: current.roles, activeRole: next };
  }

  return { ok: true, ...current };
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
  if (commercial.length >= 2) {
    return { ok: false, code: "ROLE_ADD_DISABLED", message: "Account already has both commercial roles" };
  }
  return { ok: true };
}

module.exports = {
  sanitizeRolesForStorage,
  validateRoleMutation,
  validateAddRole,
  commercialOnly
};
