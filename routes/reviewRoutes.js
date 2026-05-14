const express = require("express");
const { body, param } = require("express-validator");
const { protect } = require("../middleware/authMiddleware");
const { validationResult } = require("express-validator");
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
    return sendError(res, 400, errors.array()[0]?.msg || "Validation error");
  }
  next();
}

router.post(
  "/",
  protect,
  [
    body("toUser").custom((v) => (isUuid(v) ? true : (() => { throw new Error("toUser is required"); })())),
    body("rating").isInt({ min: 1, max: 5 }).withMessage("rating must be 1–5"),
    body("comment").optional().isString(),
    body("loadId").optional().custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid loadId"); })()))
  ],
  validate,
  async (req, res) => {
    const toUserId = String(req.body.toUser);
    const score = Number(req.body.rating);
    const comment = req.body.comment != null ? String(req.body.comment).trim() : null;
    const loadId = req.body.loadId ? String(req.body.loadId).trim() : null;

    // Derive shipment_id if loadId provided
    let shipmentId = null;
    if (loadId) {
      const { rows } = await query(`SELECT id FROM shipments WHERE load_id = $1`, [loadId]);
      shipmentId = rows[0]?.id || null;
    }
    if (!shipmentId) {
      return sendError(res, 400, "loadId is required");
    }

    const { rows } = await query(
      `INSERT INTO ratings (shipment_id, from_user_id, to_user_id, score, comment)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (shipment_id, from_user_id)
       DO UPDATE SET score = EXCLUDED.score, comment = EXCLUDED.comment
       RETURNING id, score, comment, created_at AS "createdAt"`,
      [shipmentId, req.auth.userId, toUserId, score, comment]
    );

    return sendSuccess(res, 201, rows[0], "Submitted");
  }
);

router.get(
  "/:userId",
  protect,
  [param("userId").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid userId"); })()))],
  validate,
  async (req, res) => {
    const { rows } = await query(
      `SELECT r.id, r.score AS rating, r.comment, r.created_at AS "createdAt",
              r.from_user_id AS "fromUserId", r.to_user_id AS "toUserId"
       FROM ratings r
       WHERE r.to_user_id = $1
       ORDER BY r.created_at DESC
       LIMIT 200`,
      [req.params.userId]
    );
    return sendSuccess(res, 200, rows);
  }
);

module.exports = router;
