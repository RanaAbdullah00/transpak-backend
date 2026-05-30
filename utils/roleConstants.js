/** Role constants — no userRepo import (avoids circular dependency with rolePolicy). */
const ALLOWED_ROLES = ["shipper", "carrier", "admin"];

function normalizeRole(value) {
  const v = String(value || "").trim().toLowerCase();
  return ALLOWED_ROLES.includes(v) ? v : null;
}

function hasRole(user, role) {
  const r = normalizeRole(role);
  if (!r || !user) return false;
  const list = Array.isArray(user.roles) ? user.roles : [];
  return list.includes(r);
}

module.exports = { ALLOWED_ROLES, normalizeRole, hasRole };
