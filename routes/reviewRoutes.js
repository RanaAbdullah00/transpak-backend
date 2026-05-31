const express = require("express");
const { body, param } = require("express-validator");
const { protect, requireAnyRole } = require("../middleware/authMiddleware");
const COMMERCIAL_ROLES = ["shipper", "carrier", "admin"];
const { validationResult } = require("express-validator");
const { sendError, sendSuccess } = require("../utils/apiResponse");
const { query } = require("../db/pool");
const { notifyUser, notifyAdmins } = require("../utils/notifyEvent");
const { buildDedupeKey } = require("../utils/realtimeDispatch");

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

router.get("/pending", protect, requireAnyRole(COMMERCIAL_ROLES), async (req, res) => {
  try {
    const uid = String(req.auth.userId);
    const pending = [];

    const { rows: shipRows } = await query(
      `SELECT l.id AS "loadId", l.code AS "loadCode",
              CASE WHEN l.shipper_id = $1 THEN l.assigned_carrier_id ELSE l.shipper_id END AS "toUserId",
              CASE WHEN l.shipper_id = $1
                THEN COALESCE(uc.full_name, uc.email, 'Carrier')
                ELSE COALESCE(us.full_name, us.email, 'Shipper')
              END AS "toUserName",
              l.origin, l.destination
       FROM shipments s
       JOIN loads l ON l.id = s.load_id
       LEFT JOIN users uc ON uc.id = l.assigned_carrier_id
       LEFT JOIN users us ON us.id = l.shipper_id
       WHERE s.status IN ('delivered', 'closed')
         AND (l.shipper_id = $1 OR l.assigned_carrier_id = $1)
         AND NOT EXISTS (
           SELECT 1 FROM ratings r WHERE r.shipment_id = s.id AND r.from_user_id = $1
         )
       ORDER BY s.updated_at DESC
       LIMIT 20`,
      [uid]
    );
    for (const row of shipRows) {
      if (!row.toUserId) continue;
      pending.push({
        kind: "shipment",
        loadId: row.loadId,
        loadCode: row.loadCode,
        toUserId: row.toUserId,
        toUserName: row.toUserName,
        label: `${row.origin || ""} → ${row.destination || ""}`.trim() || row.loadCode
      });
    }

    const { rows: spaceRows } = await query(
      `SELECT r.id AS "spaceRequestId",
              CASE WHEN r.shipper_id = $1 THEN l.carrier_id ELSE r.shipper_id END AS "toUserId",
              CASE WHEN r.shipper_id = $1
                THEN COALESCE(uc.full_name, uc.email, 'Carrier')
                ELSE COALESCE(us.full_name, us.email, 'Shipper')
              END AS "toUserName",
              l.origin, l.destination
       FROM carrier_space_requests r
       JOIN carrier_space_listings l ON l.id = r.listing_id
       LEFT JOIN users uc ON uc.id = l.carrier_id
       LEFT JOIN users us ON us.id = r.shipper_id
       WHERE r.status = 'completed'
         AND (r.shipper_id = $1 OR l.carrier_id = $1)
         AND NOT EXISTS (
           SELECT 1 FROM ratings rt
           WHERE rt.space_request_id = r.id AND rt.from_user_id = $1
         )
       ORDER BY r.updated_at DESC
       LIMIT 20`,
      [uid]
    );
    for (const row of spaceRows) {
      if (!row.toUserId) continue;
      pending.push({
        kind: "space",
        spaceRequestId: row.spaceRequestId,
        toUserId: row.toUserId,
        toUserName: row.toUserName,
        label: `${row.origin || ""} → ${row.destination || ""}`.trim()
      });
    }

    return sendSuccess(res, 200, pending);
  } catch (err) {
    return sendError(res, 500, err.message || "Server error");
  }
});

router.post(
  "/",
  protect,
  requireAnyRole(COMMERCIAL_ROLES),
  [
    body("toUser").custom((v) => (isUuid(v) ? true : (() => { throw new Error("toUser is required"); })())),
    body("rating").isInt({ min: 1, max: 5 }).withMessage("rating must be 1–5"),
    body("comment").optional().isString().isLength({ max: 2000 }).withMessage("comment too long"),
    body("loadId").optional().custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid loadId"); })())),
    body("spaceRequestId")
      .optional()
      .custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid spaceRequestId"); })()))
  ],
  validate,
  async (req, res) => {
    const toUserId = String(req.body.toUser);
    const score = Number(req.body.rating);
    const comment = req.body.comment != null ? String(req.body.comment).trim() : null;
    const loadId = req.body.loadId ? String(req.body.loadId).trim() : null;
    const spaceRequestId = req.body.spaceRequestId ? String(req.body.spaceRequestId).trim() : null;

    if (toUserId === String(req.auth.userId)) {
      return sendError(res, 400, "Cannot review yourself");
    }
    if (!loadId && !spaceRequestId) {
      return sendError(res, 400, "loadId or spaceRequestId is required");
    }
    if (loadId && spaceRequestId) {
      return sendError(res, 400, "Provide only one of loadId or spaceRequestId");
    }

    const uid = String(req.auth.userId);
    let rows;

    if (loadId) {
      const { rows: shipRows } = await query(
        `SELECT s.id, s.status, l.shipper_id, l.assigned_carrier_id
         FROM shipments s
         JOIN loads l ON l.id = s.load_id
         WHERE s.load_id = $1`,
        [loadId]
      );
      const ship = shipRows[0];
      if (!ship) return sendError(res, 400, "Shipment not found for this load");
      if (!["delivered", "closed"].includes(String(ship.status))) {
        return sendError(res, 409, "Reviews are allowed after delivery is completed");
      }
      if (
        ship.shipper_id &&
        ship.assigned_carrier_id &&
        String(ship.shipper_id) === String(ship.assigned_carrier_id)
      ) {
        return sendError(res, 409, "Invalid shipment parties for review");
      }
      const isParty =
        String(ship.shipper_id) === uid ||
        (ship.assigned_carrier_id && String(ship.assigned_carrier_id) === uid);
      if (!isParty) return sendError(res, 403, "You were not part of this delivery");
      const counterparty =
        String(ship.shipper_id) === uid ? ship.assigned_carrier_id : ship.shipper_id;
      if (String(counterparty) !== toUserId) {
        return sendError(res, 400, "Invalid review target for this load");
      }
      ({ rows } = await query(
        `INSERT INTO ratings (shipment_id, from_user_id, to_user_id, score, comment)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (shipment_id, from_user_id)
         DO UPDATE SET score = EXCLUDED.score, comment = EXCLUDED.comment
         RETURNING id, score AS rating, comment, created_at AS "createdAt"`,
        [ship.id, uid, toUserId, score, comment]
      ));
    } else {
      const { rows: reqRows } = await query(
        `SELECT r.id, r.status, r.shipper_id, l.carrier_id
         FROM carrier_space_requests r
         JOIN carrier_space_listings l ON l.id = r.listing_id
         WHERE r.id = $1`,
        [spaceRequestId]
      );
      const row = reqRows[0];
      if (!row) return sendError(res, 404, "Space request not found");
      if (String(row.status) !== "completed") {
        return sendError(res, 409, "Reviews are allowed after the capacity contract is completed");
      }
      const isShipper = String(row.shipper_id) === uid;
      const isCarrier = String(row.carrier_id) === uid;
      if (!isShipper && !isCarrier) return sendError(res, 403, "Forbidden");
      const counterparty = isShipper ? row.carrier_id : row.shipper_id;
      if (String(counterparty) !== toUserId) {
        return sendError(res, 400, "Invalid review target for this contract");
      }
      const { rows: existing } = await query(
        `SELECT id FROM ratings WHERE space_request_id = $1 AND from_user_id = $2`,
        [spaceRequestId, uid]
      );
      if (existing[0]) {
        ({ rows } = await query(
          `UPDATE ratings SET score = $3, comment = $4
           WHERE space_request_id = $1 AND from_user_id = $2
           RETURNING id, score AS rating, comment, created_at AS "createdAt"`,
          [spaceRequestId, uid, score, comment]
        ));
      } else {
        ({ rows } = await query(
          `INSERT INTO ratings (space_request_id, from_user_id, to_user_id, score, comment)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, score AS rating, comment, created_at AS "createdAt"`,
          [spaceRequestId, uid, toUserId, score, comment]
        ));
      }
    }

    await notifyUser({
      receiverId: toUserId,
      senderId: req.auth.userId,
      roleType: "platform",
      title: "REVIEW_RECEIVED",
      message: `You received a ${score}-star review`
    });
    void notifyAdmins({
      senderId: req.auth.userId,
      title: "REVIEW_RECEIVED",
      type: "REVIEW_RECEIVED",
      message: `[Platform] ${score}-star rating submitted`,
      idempotencyKey: buildDedupeKey(["ADMIN", "REVIEW_RECEIVED", rows[0].id])
    });

    return sendSuccess(res, 201, rows[0], "Submitted");
  }
);

router.get(
  "/:userId",
  protect,
  requireAnyRole(COMMERCIAL_ROLES),
  [param("userId").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid userId"); })()))],
  validate,
  async (req, res) => {
    const userId = req.params.userId;
    const { rows: stats } = await query(
      `SELECT COALESCE(AVG(score), 0)::numeric(10,2) AS "ratingAverage", COUNT(*)::int AS "ratingCount"
       FROM ratings WHERE to_user_id = $1`,
      [userId]
    );
    const { rows } = await query(
      `SELECT r.id, r.score AS rating, r.comment, r.created_at AS "createdAt",
              r.from_user_id AS "fromUserId",
              COALESCE(u.full_name, u.email, 'User') AS "fromName"
       FROM ratings r
       LEFT JOIN users u ON u.id = r.from_user_id
       WHERE r.to_user_id = $1
       ORDER BY r.created_at DESC
       LIMIT 200`,
      [userId]
    );
    return sendSuccess(res, 200, {
      ratingAverage: Number(stats[0]?.ratingAverage || 0),
      ratingCount: Number(stats[0]?.ratingCount || 0),
      reviews: rows
    });
  }
);

module.exports = router;
