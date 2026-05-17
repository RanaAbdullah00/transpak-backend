const express = require("express");
const { body, param, validationResult } = require("express-validator");
const { protect } = require("../middleware/authMiddleware");
const { sendError, sendSuccess } = require("../utils/apiResponse");
const { query } = require("../db/pool");

const router = express.Router();

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

router.get("/unread-count", protect, async (req, res) => {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS count
     FROM notifications
     WHERE receiver_id = $1 AND read = false`,
    [req.auth.userId]
  );
  return sendSuccess(res, 200, { count: rows[0]?.count || 0 });
});

router.get("/", protect, async (req, res) => {
  const { rows } = await query(
    `SELECT id, sender_id AS "senderId", receiver_id AS "receiverId", role_type AS "roleType",
            title, message, read, created_at AS "createdAt"
     FROM notifications
     WHERE receiver_id = $1
     ORDER BY created_at DESC
     LIMIT 200`,
    [req.auth.userId]
  );
  return sendSuccess(res, 200, rows);
});

router.post(
  "/",
  protect,
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
      roleType = rt;
    }
    const { rows: existing } = await query(
      `SELECT id, title, message, role_type AS "roleType", read, created_at AS "createdAt"
       FROM notifications
       WHERE receiver_id = $1 AND title = $2 AND message = $3
         AND created_at > now() - interval '2 minutes'
       LIMIT 1`,
      [req.auth.userId, title, message]
    );
    if (existing[0]) {
      return sendSuccess(res, 200, existing[0], "OK");
    }
    const { rows } = await query(
      `INSERT INTO notifications (receiver_id, sender_id, role_type, title, message)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, title, message, role_type AS "roleType", read, created_at AS "createdAt"`,
      [req.auth.userId, req.auth.userId, roleType, title, message]
    );
    return sendSuccess(res, 201, rows[0], "Created");
  }
);

router.patch(
  "/:id/read",
  protect,
  [param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid notification id"); })()))],
  validate,
  async (req, res) => {
    const { rows } = await query(
      `UPDATE notifications
       SET read = true
       WHERE id = $1 AND receiver_id = $2
       RETURNING id, read`,
      [req.params.id, req.auth.userId]
    );
    if (!rows[0]) return sendError(res, 404, "Not found");
    return sendSuccess(res, 200, { ok: true });
  }
);

router.patch("/read-all", protect, async (req, res) => {
  await query(`UPDATE notifications SET read = true WHERE receiver_id = $1 AND read = false`, [req.auth.userId]);
  return sendSuccess(res, 200, { ok: true });
});

module.exports = router;
