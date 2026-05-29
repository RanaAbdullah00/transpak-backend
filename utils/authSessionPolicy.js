const userRepo = require("../repositories/userRepo");
const { isDemoAdminEmail } = require("./demoAdmin");

function isAdminAccount(user) {
  return Boolean(user && userRepo.hasRole(user, "admin"));
}

function commercialRoles(user) {
  return (Array.isArray(user?.roles) ? user.roles : []).filter((r) => r === "shipper" || r === "carrier");
}

function normalizeRolesAndActiveRole(user) {
  const allowed = userRepo.ALLOWED_ROLES;
  const raw = Array.isArray(user.roles) ? user.roles : [];
  const roles = [...new Set(raw.map((r) => String(r || "").trim().toLowerCase()).filter((r) => allowed.includes(r)))];
  if (!roles.length) return { ok: false };
  const activeRaw = user.activeRole != null ? String(user.activeRole).trim().toLowerCase() : "";
  const active = roles.includes(activeRaw) ? activeRaw : roles.includes("admin") ? "admin" : roles[0];
  return { ok: true, roles, activeRole: active };
}

/** Login workspace: admin always admin; commercial users use fixed DB role (no roleHint). */
function resolveLoginActiveRole(user, email) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (isDemoAdminEmail(normalizedEmail) || isAdminAccount(user)) {
    return "admin";
  }
  const normalized = normalizeRolesAndActiveRole(user);
  if (!normalized.ok) return null;
  const commercial = commercialRoles({ roles: normalized.roles });
  if (!commercial.length) return normalized.activeRole;
  if (commercial.length === 1) return commercial[0];
  if (commercial.includes(normalized.activeRole)) return normalized.activeRole;
  return commercial[0];
}

/** Admin locked to admin; commercial users cannot switch workspace. */
function canChangeActiveRole(user, nextRole) {
  const next = String(nextRole || "").trim().toLowerCase();
  if (!next) return false;
  if (isAdminAccount(user)) return next === "admin";
  const current = String(user.activeRole || "").trim().toLowerCase();
  return current === next;
}

async function resolveAuthUserForSession(user) {
  if (!user) return null;
  if (isAdminAccount(user)) {
    if (user.activeRole === "admin") return user;
    const updated = await userRepo.setActiveRole(user.id, "admin");
    return updated || { ...user, activeRole: "admin" };
  }
  return user;
}

module.exports = {
  isAdminAccount,
  commercialRoles,
  normalizeRolesAndActiveRole,
  resolveLoginActiveRole,
  canChangeActiveRole,
  resolveAuthUserForSession
};
