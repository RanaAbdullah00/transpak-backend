const { query } = require("../db/pool");
const { buildDedupeKey, newEventId, emitDispatchEvent, DISPATCH_TYPES } = require("./realtimeDispatch");

const MAX_CARRIER_BROADCAST = Number(process.env.LOAD_NOTIFY_CARRIER_LIMIT || 250);
const SOCKET_FLUSH_MS = Number(process.env.NOTIFY_SOCKET_FLUSH_MS || 400);
const DEDUPE_WINDOW_MS = Number(process.env.NOTIFY_DEDUPE_MS || 120000);

/** @type {Map<string, { payloads: object[], timer: NodeJS.Timeout|null, roleType: string|null, seen: Set<string> }>} */
const socketQueues = new Map();

/** In-memory idempotency (per process) */
const memoryDedupe = new Map();

function dedupeKeyFromContent(receiverId, title, message) {
  return buildDedupeKey([receiverId, title, String(message).slice(0, 120)]);
}

function pruneMemoryDedupe(now) {
  if (memoryDedupe.size < 5000) return;
  for (const [k, ts] of memoryDedupe) {
    if (now - ts > DEDUPE_WINDOW_MS) memoryDedupe.delete(k);
  }
}

function toSocketPayload(row, eventType) {
  return {
    eventId: row.eventId || row.event_id || row.id,
    id: row.id,
    senderId: row.senderId,
    receiverId: row.receiverId,
    roleType: row.roleType,
    type: eventType,
    title: row.title,
    message: row.message,
    read: Boolean(row.read),
    createdAt: row.createdAt
  };
}

function queueSocketEmit(receiverId, payload, roleType) {
  if (socketQueues.size > 800) {
    const oldest = socketQueues.keys().next().value;
    const stale = oldest != null ? socketQueues.get(oldest) : null;
    if (stale?.timer) clearTimeout(stale.timer);
    if (oldest != null) socketQueues.delete(oldest);
  }
  const role = roleType != null ? String(roleType).trim().toLowerCase() : null;
  const key = `${receiverId}|${role || "any"}`;
  let q = socketQueues.get(key);
  if (!q) {
    q = { payloads: [], timer: null, roleType: role, seen: new Set() };
    socketQueues.set(key, q);
  }
  const eid = payload?.eventId ? String(payload.eventId) : null;
  if (eid && q.seen.has(eid)) return;
  if (eid) q.seen.add(eid);
  q.payloads.push(payload);
  if (!q.timer) {
    q.timer = setTimeout(() => flushSocketQueue(receiverId, role), SOCKET_FLUSH_MS);
  }
}

function flushSocketQueue(receiverId, roleType) {
  const { emitToUserRole } = require("../services/realtimeHub");
  const role = roleType != null ? String(roleType).trim().toLowerCase() : null;
  const key = `${receiverId}|${role || "any"}`;
  const q = socketQueues.get(key);
  if (!q) return;
  socketQueues.delete(key);
  if (q.timer) clearTimeout(q.timer);
  const items = q.payloads;
  if (!items.length) return;
  const rt = role || items[0]?.roleType || null;

  items.forEach((payload) => {
    emitDispatchEvent({
      eventId: payload.eventId,
      type: payload.type || DISPATCH_TYPES.NOTIFICATION,
      receiverId,
      roleType: rt,
      at: payload.createdAt,
      notification: payload,
      payload: { title: payload.title, message: payload.message }
    });
  });

  if (items.length === 1) {
    emitToUserRole(receiverId, rt, "notification:new", items[0]);
    return;
  }
  emitToUserRole(receiverId, rt, "notifications:batch", { items });
}

async function findByDedupeKey(receiverId, dedupeKey) {
  const { rows } = await query(
    `SELECT id, event_id AS "eventId", sender_id AS "senderId", receiver_id AS "receiverId",
            role_type AS "roleType", title, message, read, created_at AS "createdAt"
     FROM notifications
     WHERE receiver_id = $1 AND dedupe_key = $2
     LIMIT 1`,
    [receiverId, dedupeKey]
  );
  return rows[0] || null;
}

async function findRecentNotification(receiverId, title, message) {
  const { rows } = await query(
    `SELECT id, event_id AS "eventId", sender_id AS "senderId", receiver_id AS "receiverId",
            role_type AS "roleType", title, message, read, created_at AS "createdAt"
     FROM notifications
     WHERE receiver_id = $1 AND title = $2 AND message = $3
       AND created_at > now() - interval '2 minutes'
     ORDER BY created_at DESC
     LIMIT 1`,
    [receiverId, String(title).slice(0, 200), String(message).slice(0, 2000)]
  );
  return rows[0] || null;
}

async function insertNotification({ receiverId, senderId, roleType, title, message, dedupeKey, eventId }) {
  try {
    const { rows } = await query(
      `INSERT INTO notifications (receiver_id, sender_id, role_type, title, message, dedupe_key, event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (receiver_id, dedupe_key) DO NOTHING
       RETURNING id, event_id AS "eventId", sender_id AS "senderId", receiver_id AS "receiverId",
                 role_type AS "roleType", title, message, read, created_at AS "createdAt"`,
      [
        receiverId,
        senderId || null,
        roleType || null,
        String(title).slice(0, 200),
        String(message).slice(0, 2000),
        dedupeKey,
        eventId
      ]
    );
    if (rows[0]) return rows[0];
    if (dedupeKey) return findByDedupeKey(receiverId, dedupeKey);
    return null;
  } catch (err) {
    if (String(err.code) === "23505") {
      if (dedupeKey) return findByDedupeKey(receiverId, dedupeKey);
      return findRecentNotification(receiverId, title, message);
    }
    throw err;
  }
}

async function notifyUser({ receiverId, senderId, roleType, title, message, type, idempotencyKey }) {
  if (!receiverId || !title || !message) return null;
  const eventType = type || title;
  const dedupeKey = idempotencyKey || dedupeKeyFromContent(receiverId, title, message);
  const now = Date.now();
  pruneMemoryDedupe(now);
  if (memoryDedupe.has(dedupeKey) && now - memoryDedupe.get(dedupeKey) < DEDUPE_WINDOW_MS) {
    const cached = await findByDedupeKey(receiverId, dedupeKey);
    if (cached) {
      queueSocketEmit(receiverId, toSocketPayload(cached, eventType), cached.roleType);
    }
    return cached;
  }

  try {
    const existing =
      (await findByDedupeKey(receiverId, dedupeKey)) ||
      (await findRecentNotification(receiverId, title, message));
    if (existing) {
      memoryDedupe.set(dedupeKey, now);
      queueSocketEmit(receiverId, toSocketPayload(existing, eventType), existing.roleType);
      return existing;
    }

    const eventId = newEventId();
    const row = await insertNotification({
      receiverId,
      senderId,
      roleType,
      title,
      message,
      dedupeKey,
      eventId
    });
    memoryDedupe.set(dedupeKey, now);
    if (row) {
      queueSocketEmit(receiverId, toSocketPayload(row, eventType), row.roleType);
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
    const broadcastKey = buildDedupeKey(["LOAD_POSTED", loadCode, origin, destination]);
    let sent = 0;
    for (const row of rows) {
      const ok = await notifyUser({
        receiverId: row.id,
        senderId: shipperId,
        roleType: "carrier",
        title: "LOAD_POSTED",
        type: DISPATCH_TYPES.LOAD_POSTED,
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

function flushAllNotificationQueues() {
  for (const key of [...socketQueues.keys()]) {
    const [receiverId, role] = key.split("|");
    flushSocketQueue(receiverId, role === "any" ? null : role);
  }
}

module.exports = {
  notifyUser,
  notifyLoadPostedToCarriers,
  flushAllNotificationQueues,
  dedupeKeyFromContent
};
