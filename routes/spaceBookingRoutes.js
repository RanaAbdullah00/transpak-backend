const express = require("express");
const { body, param, validationResult } = require("express-validator");
const { protect, requireAnyRole, requireRole } = require("../middleware/authMiddleware");
const { sendSuccess, sendError } = require("../utils/apiResponse");
const { query, getPool } = require("../db/pool");
const { notifyUser } = require("../utils/notifyEvent");
const { assertSpaceTransition } = require("../utils/spaceRequestState");
const { asyncHandler } = require("../utils/asyncHandler");
const {
  canActOnSpaceRequestAsCarrier,
  canActOnSpaceRequestAsParty,
  sendForbidden,
  FORBIDDEN_CODES
} = require("../utils/resourceAuth");

const router = express.Router();

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendError(res, 400, errors.array()[0]?.msg || "Validation error");
  }
  return next();
}

router.post(
  "/:listingId/request",
  protect,
  requireRole("shipper"),
  [
    param("listingId").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid listing"); })())),
    body("requestedKg").toFloat().isFloat({ gt: 0 }),
    body("message").optional().trim().isLength({ max: 500 })
  ],
  validate,
  async (req, res) => {
    const listingId = req.params.listingId;
    const requestedKg = Number(req.body.requestedKg);
    const message = req.body.message ? String(req.body.message).trim() : null;

    const { rows: listingRows } = await query(
      `SELECT id, carrier_id, remaining_space_kg, status, origin, destination
       FROM carrier_space_listings WHERE id = $1`,
      [listingId]
    );
    const listing = listingRows[0];
    if (!listing) return sendError(res, 404, "Listing not found");
    if (listing.status !== "open") return sendError(res, 409, "Listing is not open");
    if (requestedKg > Number(listing.remaining_space_kg)) {
      return sendError(res, 400, "Requested capacity exceeds remaining space");
    }
    if (String(listing.carrier_id) === String(req.auth.userId)) {
      return sendError(res, 403, "Cannot request your own listing");
    }

    const { rows } = await query(
      `INSERT INTO carrier_space_requests (listing_id, shipper_id, requested_kg, message, status)
       VALUES ($1, $2, $3, $4, 'request_sent')
       ON CONFLICT (listing_id, shipper_id)
       DO UPDATE SET requested_kg = EXCLUDED.requested_kg, message = EXCLUDED.message,
                     status = 'request_sent', updated_at = now()
       RETURNING id, listing_id AS "listingId", shipper_id AS "shipperId",
                 requested_kg AS "requestedKg", message, status, created_at AS "createdAt"`,
      [listingId, req.auth.userId, requestedKg, message]
    );

    await notifyUser({
      receiverId: listing.carrier_id,
      senderId: req.auth.userId,
      roleType: "carrier",
      title: "SPACE_REQUEST",
      type: "SPACE_REQUEST",
      message: `Capacity request: ${listing.origin} → ${listing.destination} (${requestedKg} kg)`
    });

    return sendSuccess(res, 201, rows[0], "Request sent");
  }
);

router.get("/requests/incoming", protect, requireRole("carrier"), async (req, res) => {
  const { rows } = await query(
    `SELECT r.id, r.listing_id AS "listingId", r.shipper_id AS "shipperId",
            r.requested_kg AS "requestedKg", r.message, r.status, r.created_at AS "createdAt",
            l.origin, l.destination, l.remaining_space_kg AS "remainingSpaceKg",
            COALESCE(u.full_name, u.email, 'Shipper') AS "shipperName"
     FROM carrier_space_requests r
     JOIN carrier_space_listings l ON l.id = r.listing_id
     JOIN users u ON u.id = r.shipper_id
     WHERE l.carrier_id = $1 AND r.status NOT IN ('rejected', 'completed')
     ORDER BY r.created_at DESC
     LIMIT 100`,
    [req.auth.userId]
  );
  return sendSuccess(res, 200, rows);
});

router.get("/requests/sent", protect, requireRole("shipper"), async (req, res) => {
  const { rows } = await query(
    `SELECT r.id, r.listing_id AS "listingId", r.requested_kg AS "requestedKg",
            r.message, r.status, r.created_at AS "createdAt",
            l.origin, l.destination, l.carrier_id AS "carrierId",
            COALESCE(u.full_name, u.email, 'Carrier') AS "carrierName"
     FROM carrier_space_requests r
     JOIN carrier_space_listings l ON l.id = r.listing_id
     JOIN users u ON u.id = l.carrier_id
     WHERE r.shipper_id = $1
     ORDER BY r.created_at DESC
     LIMIT 100`,
    [req.auth.userId]
  );
  return sendSuccess(res, 200, rows);
});

async function transitionRequest(req, res, nextStatus) {
  const requestId = req.params.id;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: reqRows } = await client.query(
      `SELECT r.id, r.listing_id, r.shipper_id, r.requested_kg, r.status,
              l.carrier_id, l.remaining_space_kg, l.origin, l.destination
       FROM carrier_space_requests r
       JOIN carrier_space_listings l ON l.id = r.listing_id
       WHERE r.id = $1
       FOR UPDATE`,
      [requestId]
    );
    const row = reqRows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return sendError(res, 404, "Request not found");
    }
    if (!canActOnSpaceRequestAsCarrier(row, req.auth)) {
      await client.query("ROLLBACK");
      return sendForbidden(
        res,
        "Only the listing carrier may perform this action",
        FORBIDDEN_CODES.FORBIDDEN_OWNER
      );
    }

    assertSpaceTransition(row.status, nextStatus);

    if (nextStatus === "accepted" || nextStatus === "active") {
      const rem = Number(row.remaining_space_kg);
      if (Number(row.requested_kg) > rem) {
        await client.query("ROLLBACK");
        return sendError(res, 409, "Insufficient remaining capacity");
      }
      await client.query(
        `UPDATE carrier_space_listings
         SET remaining_space_kg = remaining_space_kg - $2,
             status = CASE WHEN remaining_space_kg - $2 <= 0 THEN 'booked' ELSE status END,
             updated_at = now()
         WHERE id = $1`,
        [row.listing_id, row.requested_kg]
      );
    }

    const dbStatus = nextStatus === "accepted" ? "active" : nextStatus;

    await client.query(
      `UPDATE carrier_space_requests SET status = $2, updated_at = now() WHERE id = $1`,
      [requestId, dbStatus]
    );

    if (nextStatus === "completed") {
      await client.query(
        `UPDATE carrier_space_listings SET status = 'closed', updated_at = now() WHERE id = $1`,
        [row.listing_id]
      );
    }

    await client.query("COMMIT");

    const notifyMap = {
      accepted: ["SPACE_ACCEPTED", "Your capacity request was accepted"],
      active: ["CONTRACT_STARTED", "Capacity contract is now active"],
      rejected: ["SPACE_REJECTED", "Your capacity request was declined"],
      in_transit: ["SPACE_IN_TRANSIT", "Shipment is in transit on shared capacity"],
      completed: ["SPACE_COMPLETED", "Capacity contract completed — leave a review"]
    };
    const [title, msgBase] = notifyMap[nextStatus] || ["SPACE_UPDATE", "Request updated"];
    await notifyUser({
      receiverId: row.shipper_id,
      senderId: row.carrier_id,
      roleType: "shipper",
      title,
      type: title,
      message: `${msgBase}: ${row.origin} → ${row.destination}`
    });

    return sendSuccess(res, 200, { ok: true, status: dbStatus.toUpperCase() });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    if (err.code === "INVALID_SPACE_TRANSITION" || err.code === "INVALID_SPACE_STATE") {
      return sendError(res, err.statusCode || 409, err.message, { code: err.code });
    }
    return sendError(res, 500, err.message || "Server error");
  } finally {
    client.release();
  }
}

async function partyTransition(req, res, nextStatus) {
  const requestId = req.params.id;
  const { rows: reqRows } = await query(
    `SELECT r.id, r.status, r.shipper_id, l.carrier_id, l.origin, l.destination
     FROM carrier_space_requests r
     JOIN carrier_space_listings l ON l.id = r.listing_id
     WHERE r.id = $1`,
    [requestId]
  );
  const row = reqRows[0];
  if (!row) return sendError(res, 404, "Not found");
  const uid = String(req.auth.userId);
  const isShipper = String(row.shipper_id) === uid;
  if (!canActOnSpaceRequestAsParty(row, req.auth)) {
    return sendForbidden(res, "You are not a party to this capacity request", FORBIDDEN_CODES.FORBIDDEN_RESOURCE);
  }
  try {
    assertSpaceTransition(row.status, nextStatus);
  } catch (err) {
    return sendError(res, err.statusCode || 409, err.message, { code: err.code });
  }
  await query(`UPDATE carrier_space_requests SET status = $2, updated_at = now() WHERE id = $1`, [
    requestId,
    nextStatus
  ]);
  const otherId = isShipper ? row.carrier_id : row.shipper_id;
  const receiverRole = isShipper ? "carrier" : "shipper";
  await notifyUser({
    receiverId: otherId,
    senderId: uid,
    roleType: receiverRole,
    title: nextStatus === "in_transit" ? "SPACE_IN_TRANSIT" : "SPACE_COMPLETED",
    type: nextStatus === "in_transit" ? "SPACE_IN_TRANSIT" : "SPACE_COMPLETED",
    message: `Status: ${nextStatus} — ${row.origin} → ${row.destination}`
  });
  return sendSuccess(res, 200, { ok: true, status: nextStatus.toUpperCase() });
}

router.put(
  "/requests/:id/accept",
  protect,
  requireRole("carrier"),
  [param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid id"); })()))],
  validate,
  asyncHandler((req, res) => transitionRequest(req, res, "accepted"))
);

router.put(
  "/requests/:id/reject",
  protect,
  requireRole("carrier"),
  [param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid id"); })()))],
  validate,
  asyncHandler((req, res) => transitionRequest(req, res, "rejected"))
);

router.put(
  "/requests/:id/in-transit",
  protect,
  requireAnyRole(["shipper", "carrier"]),
  [param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid id"); })()))],
  validate,
  asyncHandler((req, res) => partyTransition(req, res, "in_transit"))
);

router.put(
  "/requests/:id/complete",
  protect,
  requireAnyRole(["shipper", "carrier"]),
  [param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid id"); })()))],
  validate,
  asyncHandler((req, res) => partyTransition(req, res, "completed"))
);

module.exports = router;
