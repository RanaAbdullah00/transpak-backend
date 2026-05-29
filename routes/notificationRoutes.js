const express = require("express");
const { body, param, query: qv, validationResult } = require("express-validator");
const { protect, requireAnyRole } = require("../middleware/authMiddleware");
const { sendError, sendSuccess } = require("../utils/apiResponse");
const { query } = require("../db/pool");
const { notificationScopeClause } = require("../utils/notificationScope");
const { resolveNotificationWorkspace } = require("../utils/notificationWorkspace");

const { notificationsRouteLimiter } = require("../middleware/apiRateLimit");

const router = express.Router();
router.use(notificationsRouteLimiter);

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  );
}

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendError(res, 400, errors.array()[0]?.msg || "Validation error", {
      fields: errors.array().map((e) => e.path)
    });
  }
  return next();
}

function scopedQuery(auth, req, paramIndex = 2) {
  const workspace = resolveNotificationWorkspace(req);
  const scope = notificationScopeClause(auth, workspace, paramIndex);
  return { scope, scopeParams: scope.params, workspace };
}

router.get("/unread-count", protect, requireAnyRole(["shipper", "carrier", "admin"]), async (req, res) => {
  const { scope, scopeParams } = scopedQuery(req.auth, req, 2);
  const params = [req.auth.userId, ...scopeParams];
  const { rows } = await query(
    `SELECT COUNT(*)::int AS count
     FROM notifications
     WHERE receiver_id = $1 AND read = false AND ${scope.sql}`,
    params
  );
  return sendSuccess(res, 200, { count: rows[0]?.count || 0 });
});

/** Reconnect recovery — missed notifications + authoritative unread count. */
router.get("/sync", protect, requireAnyRole(["shipper", "carrier", "admin"]), async (req, res) => {
  const { scope, scopeParams } = scopedQuery(req.auth, req, 2);
  const baseParams = [req.auth.userId, ...scopeParams];
  const sinceRaw = req.query?.since ? String(req.query.since).trim() : null;
  const limit = Math.min(100, Math.max(1, parseInt(req.query?.limit, 10) || 50));

  const { rows: countRows } = await query(
    `SELECT COUNT(*)::int AS count
     FROM notifications
     WHERE receiver_id = $1 AND read = false AND ${scope.sql}`,
    baseParams
  );

  const listParams = [...baseParams];
  let sinceClause = "";
  if (sinceRaw) {
    const d = new Date(sinceRaw);
    if (!Number.isNaN(d.getTime())) {
      listParams.push(d.toISOString());
      sinceClause = ` AND created_at > $${listParams.length}::timestamptz`;
    }
  }
  listParams.push(limit);

  const { rows } = await query(
    `SELECT id, event_id AS "eventId", sender_id AS "senderId", receiver_id AS "receiverId",
            role_type AS "roleType", title, message, read, created_at AS "createdAt"
     FROM notifications
     WHERE receiver_id = $1 AND ${scope.sql}${sinceClause}
     ORDER BY created_at ASC
     LIMIT $${listParams.length}`,
    listParams
  );

  const items = rows.map((r) => ({ ...r, type: r.title || null }));
  return sendSuccess(res, 200, {
    unreadCount: countRows[0]?.count || 0,
    items,
    serverTime: new Date().toISOString()
  });
});

router.get("/", protect, requireAnyRole(["shipper", "carrier", "admin"]), async (req, res) => {
  const { scope, scopeParams } = scopedQuery(req.auth, req, 2);
  const limit = Math.min(50, Math.max(1, parseInt(req.query?.limit, 10) || 30));
  const cursor = req.query?.cursor ? String(req.query.cursor).trim() : null;
  const baseParams = [req.auth.userId, ...scopeParams];
  let cursorClause = "";
  if (cursor) {
    const d = new Date(cursor);
    if (!Number.isNaN(d.getTime())) {
      baseParams.push(d.toISOString());
      cursorClause = ` AND created_at < $${baseParams.length}::timestamptz`;
    }
  }
  baseParams.push(limit + 1);
  const limitIdx = baseParams.length;
  const { rows } = await query(
    `SELECT id, event_id AS "eventId", sender_id AS "senderId", receiver_id AS "receiverId",
            role_type AS "roleType", title, message, read, created_at AS "createdAt"
     FROM notifications
     WHERE receiver_id = $1 AND ${scope.sql}${cursorClause}
     ORDER BY created_at DESC
     LIMIT $${limitIdx}`,
    baseParams
  );
  const hasMore = rows.length > limit;
  const page = (hasMore ? rows.slice(0, limit) : rows).map((r) => ({
    ...r,
    type: r.title || null
  }));
  const nextCursor = hasMore && page.length ? page[page.length - 1].createdAt : null;
  return sendSuccess(res, 200, { items: page, nextCursor, hasMore });
});

router.post(
  "/",
  protect,
  requireAnyRole(["shipper", "carrier", "admin"]),
  [
    body("title").trim().isLength({ min: 1, max: 120 }).withMessage("title is required"),
    body("message").trim().isLength({ min: 1, max: 2000 }).withMessage("message is required"),
    body("roleType").optional().trim().isLength({ max: 32 }).withMessage("Invalid roleType")
  ],
  validate,
  async (req, res) => {
    const title = String(req.body.title || "").trim();
    const message = String(req.body.message || "").trim();
    let roleType = req.body.roleType != null ? String(req.body.roleType).trim() : null;
    if (roleType) {
      const rt = roleType.toLowerCase();
      if (!["shipper", "carrier", "admin"].includes(rt)) {
        return sendError(res, 400, "Invalid roleType", { fields: ["roleType"] });
      }
      const roles = req.auth?.roles || [];
      if (!roles.includes(rt)) {
        return sendError(res, 403, "Forbidden", null, "FORBIDDEN_ROLE_TYPE");
      }
      roleType = rt;
    }
    const { scope, scopeParams } = scopedQuery(req.auth, req, 4);
    const { rows: existing } = await query(
      `SELECT id, event_id AS "eventId", title, message, role_type AS "roleType", read, created_at AS "createdAt"
       FROM notifications
       WHERE receiver_id = $1 AND title = $2 AND message = $3
         AND created_at > now() - interval '2 minutes'
         AND ${scope.sql}
       LIMIT 1`,
      [req.auth.userId, title, message, ...scopeParams]
    );
    if (existing[0]) {
      return sendSuccess(res, 200, existing[0], "OK");
    }
    const { notifyUser } = require("../utils/notifyEvent");
    const row = await notifyUser({
      receiverId: req.auth.userId,
      senderId: req.auth.userId,
      roleType: roleType || resolveNotificationWorkspace(req),
      title,
      message
    });
    return sendSuccess(res, 201, row || { title, message }, "Created");
  }
);

router.patch(
  "/:id/read",
  protect,
  requireAnyRole(["shipper", "carrier", "admin"]),
  [param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid notification id"); })()))],
  validate,
  async (req, res) => {
    const { scope, scopeParams } = scopedQuery(req.auth, req, 3);
    const { rows } = await query(
      `UPDATE notifications
       SET read = true
       WHERE id = $1 AND receiver_id = $2 AND ${scope.sql}
       RETURNING id, read`,
      [req.params.id, req.auth.userId, ...scopeParams]
    );
    if (!rows[0]) return sendError(res, 404, "Not found");
    return sendSuccess(res, 200, { ok: true });
  }
);

router.patch("/read-all", protect, requireAnyRole(["shipper", "carrier", "admin"]), async (req, res) => {
  const { scope, scopeParams } = scopedQuery(req.auth, req, 2);
  await query(
    `UPDATE notifications SET read = true WHERE receiver_id = $1 AND read = false AND ${scope.sql}`,
    [req.auth.userId, ...scopeParams]
  );
  return sendSuccess(res, 200, { ok: true });
});

module.exports = router;
