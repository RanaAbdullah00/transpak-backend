const { query } = require("../db/pool");
const { notifyUser, dedupeKeyFromContent } = require("./notifyEvent");
const { buildDedupeKey } = require("./realtimeDispatch");

const MAX_ADMIN_NOTIFY = Number(process.env.ADMIN_NOTIFY_LIMIT || 50);
const CACHE_MS = Number(process.env.ADMIN_NOTIFY_CACHE_MS || 60000);

let adminCache = { ids: [], at: 0 };

async function listAdminUserIds() {
  const now = Date.now();
  if (adminCache.ids.length && now - adminCache.at < CACHE_MS) {
    return adminCache.ids;
  }
  const { rows } = await query(
    `SELECT id FROM users
     WHERE blocked = false AND 'admin' = ANY(roles)
     ORDER BY created_at DESC
     LIMIT $1`,
    [MAX_ADMIN_NOTIFY]
  );
  adminCache = { ids: rows.map((r) => r.id), at: now };
  return adminCache.ids;
}

/**
 * Notify all platform admins (persisted + socket dispatch with roleType admin).
 * @returns {Promise<number>} count of admins notified
 */
async function notifyAdmins({ senderId, title, type, message, idempotencyKey }) {
  if (!title || !message) return 0;
  try {
    const adminIds = await listAdminUserIds();
    if (!adminIds.length) return 0;
    const eventType = type || title;
    const baseKey = idempotencyKey || dedupeKeyFromContent("admin", title, message);
    let sent = 0;
    for (const adminId of adminIds) {
      const ok = await notifyUser({
        receiverId: adminId,
        senderId: senderId || null,
        roleType: "admin",
        title: String(title).slice(0, 200),
        type: eventType,
        message: String(message).slice(0, 2000),
        idempotencyKey: `${baseKey}|${adminId}`
      });
      if (ok) sent += 1;
    }
    return sent;
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn("[adminNotify]", err?.message || err);
    }
    return 0;
  }
}

/** Clear cached admin ids (tests). */
function resetAdminNotifyCache() {
  adminCache = { ids: [], at: 0 };
}

module.exports = {
  notifyAdmins,
  listAdminUserIds,
  resetAdminNotifyCache,
  buildDedupeKey
};
