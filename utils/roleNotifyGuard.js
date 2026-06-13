/**
 * Lightweight role validation for notification delivery — never throws.
 */
const NOTIFICATION_GUARD_VERSION = "1.0.0";

const { query } = require("../db/pool");

const roleCache = new Map();
const CACHE_TTL_MS = 60_000;

async function getUserRoles(userId) {
  const key = String(userId || "").trim();
  if (!key) return [];
  const cached = roleCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.roles;
  try {
    const { rows } = await query(`SELECT roles FROM users WHERE id = $1 LIMIT 1`, [key]);
    const roles = (rows[0]?.roles || []).map((r) => String(r).trim().toLowerCase()).filter(Boolean);
    roleCache.set(key, { roles, at: Date.now() });
    return roles;
  } catch {
    return [];
  }
}

/**
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
async function validateNotificationRole(receiverId, roleType) {
  if (!receiverId) return { ok: false, reason: "missing_receiver" };
  const role = roleType != null ? String(roleType).trim().toLowerCase() : "";
  if (!role) return { ok: true };
  if (!["shipper", "carrier", "admin"].includes(role)) {
    return { ok: false, reason: "unknown_role" };
  }
  const roles = await getUserRoles(receiverId);
  if (!roles.length) return { ok: false, reason: "user_not_found" };
  if (!roles.includes(role)) return { ok: false, reason: "role_mismatch" };
  return { ok: true };
}

function invalidateRoleNotifyCache(userId) {
  if (userId) roleCache.delete(String(userId));
}

/** Alias used by notification pipeline — skip silently on mismatch, never throw. */
const roleNotifyGuard = validateNotificationRole;

module.exports = {
  NOTIFICATION_GUARD_VERSION,
  getUserRoles,
  validateNotificationRole,
  roleNotifyGuard,
  invalidateRoleNotifyCache
};
