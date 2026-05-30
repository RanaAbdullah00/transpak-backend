const userRepo = require("../repositories/userRepo");
const { isDemoAdminEmail } = require("./demoAdmin");
const { normalizeRole } = require("./roleConstants");

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

/** Login workspace: admin always admin; commercial users must match roleHint when provided. */
function resolveLoginActiveRole(user, email, roleHint) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (isDemoAdminEmail(normalizedEmail) || isAdminAccount(user)) {
    return "admin";
  }
  const normalized = normalizeRolesAndActiveRole(user);
  if (!normalized.ok) return null;

  const commercial = commercialRoles({ roles: normalized.roles });
  const hint = normalizeRole(roleHint);
  if (hint && hint !== "admin") {
    if (!commercial.includes(hint)) return null;
    return hint;
  }

  if (commercial.length === 1) return commercial[0];
  const dbActive = normalizeRole(normalized.activeRole);
  if (dbActive && commercial.includes(dbActive)) return dbActive;
  if (dbActive && normalized.roles.includes(dbActive)) return dbActive;
  return commercial[0] || normalized.activeRole;
}

/** Admin locked to admin; commercial users may switch between granted roles. */
function canChangeActiveRole(user, nextRole) {
  const next = String(nextRole || "").trim().toLowerCase();
  if (!next) return false;
  if (isAdminAccount(user)) return next === "admin";
  const roles = (Array.isArray(user?.roles) ? user.roles : []).map((r) =>
    String(r || "")
      .trim()
      .toLowerCase()
  );
  if (!roles.includes(next)) return false;
  const current = String(user.activeRole || "")
    .trim()
    .toLowerCase();
  return current !== next;
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
