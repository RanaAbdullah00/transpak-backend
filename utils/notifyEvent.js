const { query } = require("../db/pool");
const {
  createNotificationDedupeAdapter,
  buildEventDedupeKey,
  buildLegacyContentDedupeKey
} = require("./notificationDedupeAdapter");
const { buildDedupeKey, newEventId, emitDispatchEvent, DISPATCH_TYPES } = require("./realtimeDispatch");
const { resolveEventType } = require("./eventContractRegistry");
const { roleNotifyGuard } = require("./roleNotifyGuard");
const notifyAudit = require("./notifyAuditLog");

const MAX_INSERT_RETRIES = 3;
const RETRY_BASE_MS = 25;

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  );
}

function isRetryableDbError(err) {
  const code = String(err?.code || "");
  return code === "40P01" || code === "40001" || code === "55P03";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Pre-insert safety net — no business logic change; skip invalid payloads safely. */
function validateNotifyInsertPayload({ receiverId, eventType, dedupeKey, entityId }) {
  if (!receiverId || !isUuid(receiverId)) {
    return { ok: false, reason: "invalid_receiver_id" };
  }
  if (!eventType || !String(eventType).trim()) {
    return { ok: false, reason: "empty_event_type" };
  }
  const key = dedupeKey != null ? String(dedupeKey).trim() : "";
  if (!key) {
    return { ok: false, reason: "missing_dedupe_key" };
  }
  return { ok: true, entityId: entityId || null };
}

const MAX_CARRIER_BROADCAST = Number(process.env.LOAD_NOTIFY_CARRIER_LIMIT || 250);
const SOCKET_FLUSH_MS = Number(process.env.NOTIFY_SOCKET_FLUSH_MS || 400);

/** @type {Map<string, { payloads: object[], timer: NodeJS.Timeout|null, roleType: string|null, seen: Set<string> }>} */
const socketQueues = new Map();

/** In-memory idempotency (per process). Adapter preserves Phase 3 behavior; Redis-ready for multi-instance. */
const notificationDedupe = createNotificationDedupeAdapter();

function dedupeKeyFromContent(receiverId, title, message) {
  return buildLegacyContentDedupeKey(receiverId, title, message);
}

function resolveNotificationDedupeKey({
  eventType,
  receiverId,
  title,
  message,
  idempotencyKey,
  entityId,
  eventVersion
}) {
  if (idempotencyKey) return String(idempotencyKey).trim();
  if (entityId) return buildEventDedupeKey(eventType, entityId, receiverId, eventVersion);
  return dedupeKeyFromContent(receiverId, title, message);
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
  // dispatch:event is the single socket channel (includes notification payload).
  // Avoid also emitting notification:new / notifications:batch — clients dedupe poorly
  // and users can see duplicate toasts + sounds.
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
  const safeKey = dedupeKey ? String(dedupeKey).trim() : null;
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_INSERT_RETRIES; attempt++) {
    try {
      const { rows } = await query(
        `INSERT INTO notifications (receiver_id, sender_id, role_type, title, message, dedupe_key, event_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT ON CONSTRAINT uq_notifications_receiver_dedupe_full DO NOTHING
         RETURNING id, event_id AS "eventId", sender_id AS "senderId", receiver_id AS "receiverId",
                   role_type AS "roleType", title, message, read, created_at AS "createdAt"`,
        [
          receiverId,
          senderId || null,
          roleType || null,
          String(title).slice(0, 200),
          String(message).slice(0, 2000),
          safeKey,
          eventId
        ]
      );
      if (rows[0]) return rows[0];
      if (safeKey) return findByDedupeKey(receiverId, safeKey);
      return null;
    } catch (err) {
      lastErr = err;
      if (String(err.code) === "23505") {
        if (safeKey) return findByDedupeKey(receiverId, safeKey);
        return findRecentNotification(receiverId, title, message);
      }
      if (isRetryableDbError(err) && attempt < MAX_INSERT_RETRIES - 1) {
        await sleep(RETRY_BASE_MS * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error("insert notification failed");
}

async function notifyUser({
  receiverId,
  senderId,
  roleType,
  title,
  message,
  type,
  idempotencyKey,
  entityId,
  eventVersion
}) {
  if (!receiverId || !title || !message) return null;

  try {
    const roleCheck = await roleNotifyGuard(receiverId, roleType);
    if (!roleCheck.ok) {
      // eslint-disable-next-line no-console
      console.warn("[notify] skipped — role mismatch", {
        receiverId,
        roleType,
        reason: roleCheck.reason
      });
      return null;
    }
  } catch (guardErr) {
    // eslint-disable-next-line no-console
    console.warn("[notify] role guard error — skipped", guardErr?.message || guardErr);
    return null;
  }

  const eventType = resolveEventType(type || title);
  const hasEventIdentity = Boolean(idempotencyKey || entityId);
  const dedupeKey = resolveNotificationDedupeKey({
    eventType,
    receiverId,
    title,
    message,
    idempotencyKey,
    entityId,
    eventVersion
  });

  const precheck = validateNotifyInsertPayload({
    receiverId,
    eventType,
    dedupeKey,
    entityId
  });
  if (!precheck.ok) {
    // eslint-disable-next-line no-console
    console.warn("[notify] precheck skipped insert", {
      reason: precheck.reason,
      receiverId,
      eventType,
      entityId: entityId || null
    });
    notifyAudit.record({
      eventType,
      entityId,
      receiverId,
      dedupeKey,
      status: "fail",
      error: precheck.reason
    });
    return null;
  }

  const now = Date.now();
  notificationDedupe.clearExpired(now);
  if (await notificationDedupe.has(dedupeKey)) {
    const cached = await findByDedupeKey(receiverId, dedupeKey);
    if (cached) {
      queueSocketEmit(receiverId, toSocketPayload(cached, eventType), cached.roleType);
      return cached;
    }
    // Stale in-memory/redis dedupe entry without DB row — fall through to insert
  }

  try {
    let existing = await findByDedupeKey(receiverId, dedupeKey);
    if (!existing && !hasEventIdentity) {
      existing = await findRecentNotification(receiverId, title, message);
    }
    if (existing) {
      await notificationDedupe.set(dedupeKey, now);
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
    await notificationDedupe.set(dedupeKey, now);
    if (row) {
      queueSocketEmit(receiverId, toSocketPayload(row, eventType), row.roleType);
      notifyAudit.record({
        eventType,
        entityId,
        receiverId,
        dedupeKey,
        status: "success"
      });
      return row;
    }
    // eslint-disable-next-line no-console
    console.error("[notify] insert returned no row", {
      receiverId,
      dedupeKey,
      eventType,
      title
    });
    notifyAudit.record({
      eventType,
      entityId,
      receiverId,
      dedupeKey,
      status: "fail",
      error: "insert_no_row"
    });
    return null;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[notify] insert failed", {
      code: err?.code,
      receiverId,
      dedupeKey,
      eventType,
      title,
      message: err?.message || String(err)
    });
    notifyAudit.record({
      eventType,
      entityId,
      receiverId,
      dedupeKey,
      status: "fail",
      error: err?.message || String(err)
    });
    if (String(err?.code) === "23505" && dedupeKey) {
      return findByDedupeKey(receiverId, dedupeKey);
    }
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
  dedupeKeyFromContent,
  buildEventDedupeKey,
  resolveNotificationDedupeKey,
  validateNotifyInsertPayload,
  getNotifyAuditSnapshot: notifyAudit.snapshot,
  getNotifyAuditStats: notifyAudit.stats
};

/** Lazy re-export — avoids circular init with adminNotify breaking notifyUser exports. */
Object.defineProperty(module.exports, "notifyAdmins", {
  enumerable: true,
  configurable: true,
  get() {
    return require("./adminNotify").notifyAdmins;
  }
});
