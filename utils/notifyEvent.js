const { query } = require("../db/pool");
const { emitToUser } = require("../services/realtimeHub");

const MAX_CARRIER_BROADCAST = Number(process.env.LOAD_NOTIFY_CARRIER_LIMIT || 250);
const SOCKET_FLUSH_MS = Number(process.env.NOTIFY_SOCKET_FLUSH_MS || 400);
const DEDUPE_WINDOW_MS = Number(process.env.NOTIFY_DEDUPE_MS || 120000);

/** @type {Map<string, { payloads: object[], timer: NodeJS.Timeout|null }>} */
const socketQueues = new Map();

/** In-memory idempotency (per process) */
const memoryDedupe = new Map();

function dedupeKey(receiverId, title, message) {
  return `${receiverId}|${title}|${String(message).slice(0, 120)}`;
}

function pruneMemoryDedupe(now) {
  if (memoryDedupe.size < 3000) return;
  for (const [k, ts] of memoryDedupe) {
    if (now - ts > DEDUPE_WINDOW_MS) memoryDedupe.delete(k);
  }
}

function queueSocketEmit(receiverId, payload) {
  let q = socketQueues.get(receiverId);
  if (!q) {
    q = { payloads: [], timer: null };
    socketQueues.set(receiverId, q);
  }
  q.payloads.push(payload);
  if (!q.timer) {
    q.timer = setTimeout(() => flushSocketQueue(receiverId), SOCKET_FLUSH_MS);
  }
}

function flushSocketQueue(receiverId) {
  const q = socketQueues.get(receiverId);
  if (!q) return;
  socketQueues.delete(receiverId);
  if (q.timer) clearTimeout(q.timer);
  const items = q.payloads;
  if (!items.length) return;
  if (items.length === 1) {
    emitToUser(receiverId, "notification:new", items[0]);
    return;
  }
  emitToUser(receiverId, "notifications:batch", { items });
}

async function findRecentNotification(receiverId, title, message) {
  const { rows } = await query(
    `SELECT id, sender_id AS "senderId", receiver_id AS "receiverId", role_type AS "roleType",
            title, message, read, created_at AS "createdAt"
     FROM notifications
     WHERE receiver_id = $1 AND title = $2 AND message = $3
       AND created_at > now() - interval '2 minutes'
     ORDER BY created_at DESC
     LIMIT 1`,
    [receiverId, String(title).slice(0, 200), String(message).slice(0, 2000)]
  );
  return rows[0] || null;
}

function toSocketPayload(row, eventType) {
  return {
    id: row.id,
    senderId: row.senderId,
    receiverId: row.receiverId,
    roleType: row.roleType,
    type: eventType,
    title: row.title,
    message: row.message,
    read: false,
    createdAt: row.createdAt
  };
}

async function notifyUser({ receiverId, senderId, roleType, title, message, type, idempotencyKey }) {
  if (!receiverId || !title || !message) return null;
  const eventType = type || title;
  const key = idempotencyKey || dedupeKey(receiverId, title, message);
  const now = Date.now();
  pruneMemoryDedupe(now);
  if (memoryDedupe.has(key) && now - memoryDedupe.get(key) < DEDUPE_WINDOW_MS) {
    return null;
  }

  try {
    const existing = await findRecentNotification(receiverId, title, message);
    if (existing) {
      memoryDedupe.set(key, now);
      queueSocketEmit(receiverId, toSocketPayload(existing, eventType));
      return existing;
    }

    const { rows } = await query(
      `INSERT INTO notifications (receiver_id, sender_id, role_type, title, message)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, sender_id AS "senderId", receiver_id AS "receiverId", role_type AS "roleType",
                 title, message, read, created_at AS "createdAt"`,
      [receiverId, senderId || null, roleType || null, String(title).slice(0, 200), String(message).slice(0, 2000)]
    );
    const row = rows[0];
    memoryDedupe.set(key, now);
    if (row) {
      queueSocketEmit(receiverId, toSocketPayload(row, eventType));
    }
    return row;
  } catch {
    return null;
  }
}

/** Notify all carrier accounts when a new open load is posted. */
async function notifyLoadPostedToCarriers({ shipperId, loadCode, origin, destination }) {
  if (!shipperId) return 0;
  try {
    const { rows } = await query(
      `SELECT id
       FROM users
       WHERE id <> $1
         AND blocked = false
         AND 'carrier' = ANY(roles)
       ORDER BY created_at DESC
       LIMIT $2`,
      [shipperId, MAX_CARRIER_BROADCAST]
    );
    const msg = `New load ${loadCode}: ${origin} → ${destination}`;
    const broadcastKey = `LOAD_POSTED|${loadCode}|${origin}|${destination}`;
    let sent = 0;
    for (const row of rows) {
      const ok = await notifyUser({
        receiverId: row.id,
        senderId: shipperId,
        roleType: "shipper",
        title: "LOAD_POSTED",
        type: "LOAD_POSTED",
        message: msg,
        idempotencyKey: `${broadcastKey}|${row.id}`
      });
      if (ok) sent += 1;
    }
    return sent;
  } catch {
    return 0;
  }
}

/** Flush pending socket batches (tests / graceful shutdown). */
function flushAllNotificationQueues() {
  for (const receiverId of [...socketQueues.keys()]) {
    flushSocketQueue(receiverId);
  }
}

module.exports = {
  notifyUser,
  notifyLoadPostedToCarriers,
  flushAllNotificationQueues
};
