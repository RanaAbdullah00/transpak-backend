const express = require("express");
const { body, param, validationResult } = require("express-validator");
const { protect, requireAnyRole, requireRole } = require("../middleware/authMiddleware");
const { sendSuccess, sendError } = require("../utils/apiResponse");
const { query, getPool } = require("../db/pool");
const { notifyUser, notifyAdmins } = require("../utils/notifyEvent");
const { buildDedupeKey } = require("../utils/realtimeDispatch");
const { assertSpaceTransition, REQUEST_SENT_OPS_SQL } = require("../utils/spaceRequestState");
const { createShipmentFromCapacityAccept } = require("../utils/capacityShipmentBridge");
const { asyncHandler } = require("../utils/asyncHandler");
const { writeAudit } = require("../utils/auditLog");
const { newEventId } = require("../utils/realtimeDispatch");
const { emitContractDispatch, emitContractEntityDispatch } = require("../utils/eventContractRegistry");
const {
  canActOnSpaceRequestAsCarrier,
  canActOnSpaceRequestAsParty,
  sendForbidden,
  FORBIDDEN_CODES
} = require("../utils/resourceAuth");

const { withIdempotencyKey } = require("../middleware/withIdempotencyKey");

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
  withIdempotencyKey("capacity_request"),
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

    const { rows: existingRows } = await query(
      `SELECT id, status FROM carrier_space_requests
       WHERE listing_id = $1 AND shipper_id = $2`,
      [listingId, req.auth.userId]
    );
    const existing = existingRows[0];
    const lockedStatuses = new Set(["active", "in_transit", "completed"]);
    if (existing && lockedStatuses.has(String(existing.status))) {
      return sendError(
        res,
        409,
        "This capacity request is already active or completed",
        null,
        "SPACE_REQUEST_LOCKED"
      );
    }

    let rows;
    if (existing) {
      ({ rows } = await query(
        `UPDATE carrier_space_requests
         SET requested_kg = $3, message = $4, status = 'request_sent', updated_at = now()
         WHERE id = $1 AND listing_id = $2 AND shipper_id = $5
         RETURNING id, listing_id AS "listingId", shipper_id AS "shipperId",
                   requested_kg AS "requestedKg", message, status, created_at AS "createdAt"`,
        [existing.id, listingId, requestedKg, message, req.auth.userId]
      ));
    } else {
      ({ rows } = await query(
        `INSERT INTO carrier_space_requests (listing_id, shipper_id, requested_kg, message, status)
         VALUES ($1, $2, $3, $4, 'request_sent')
         RETURNING id, listing_id AS "listingId", shipper_id AS "shipperId",
                   requested_kg AS "requestedKg", message, status, created_at AS "createdAt"`,
        [listingId, req.auth.userId, requestedKg, message]
      ));
    }

    if (!rows?.[0]) {
      return sendError(res, 409, "Could not create or update capacity request", null, "SPACE_REQUEST_FAILED");
    }

    void notifyUser({
      receiverId: listing.carrier_id,
      senderId: req.auth.userId,
      roleType: "carrier",
      title: "SPACE_REQUEST",
      type: "SPACE_REQUEST",
      message: `Capacity request: ${listing.origin} → ${listing.destination} (${requestedKg} kg)`,
      idempotencyKey: buildDedupeKey(["SPACE_REQUEST", rows[0].id, listing.carrier_id])
    });

    void notifyUser({
      receiverId: req.auth.userId,
      senderId: req.auth.userId,
      roleType: "shipper",
      title: "SPACE_REQUEST_SENT",
      type: "SPACE_REQUEST_SENT",
      message: `Request sent: ${listing.origin} → ${listing.destination} (${requestedKg} kg)`,
      idempotencyKey: buildDedupeKey(["SPACE_REQUEST_SENT", rows[0].id])
    });

    void notifyAdmins({
      senderId: req.auth.userId,
      title: "SPACE_REQUEST",
      type: "SPACE_REQUEST",
      message: `[Platform] Capacity request ${requestedKg} kg: ${listing.origin} → ${listing.destination}`,
      idempotencyKey: buildDedupeKey(["ADMIN", "SPACE_REQUEST", rows[0].id])
    });

    void writeAudit({
      actorUserId: req.auth.userId,
      action: "space.request_sent",
      targetEntity: "space_request",
      targetId: rows[0].id,
      metadata: { listingId, requestedKg, origin: listing.origin, destination: listing.destination }
    });

    emitContractEntityDispatch({
      entityType: "space",
      entityId: rows[0].id,
      type: "SPACE_REQUEST",
      eventId: newEventId(),
      payload: { requestId: rows[0].id, listingId, status: "request_sent" }
    });

    return sendSuccess(res, 201, rows[0], "Request sent");
  }
);

router.get("/requests/incoming", protect, requireRole("carrier"), async (req, res) => {
  const { rows } = await query(
    `SELECT r.id, r.listing_id AS "listingId", r.shipper_id AS "shipperId",
            r.requested_kg AS "requestedKg", r.message, r.status, r.created_at AS "createdAt",
            r.load_id AS "loadId", l.code AS "loadCode",
            sl.origin, sl.destination, sl.remaining_space_kg AS "remainingSpaceKg",
            sl.rate_per_kg AS "ratePerKg", sl.available_from AS "availableFrom", sl.notes AS "listingNotes",
            COALESCE(u.full_name, u.email, 'Shipper') AS "shipperName",
            u.profile_image AS "shipperAvatar"
     FROM carrier_space_requests r
     JOIN carrier_space_listings sl ON sl.id = r.listing_id
     JOIN users u ON u.id = r.shipper_id
     LEFT JOIN loads l ON l.id = r.load_id
     WHERE sl.carrier_id = $1 AND ${REQUEST_SENT_OPS_SQL}
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
            r.load_id AS "loadId", ld.code AS "loadCode",
            l.origin, l.destination, l.carrier_id AS "carrierId",
            l.rate_per_kg AS "ratePerKg", l.available_from AS "availableFrom",
            COALESCE(u.full_name, u.email, 'Carrier') AS "carrierName",
            u.profile_image AS "carrierAvatar"
     FROM carrier_space_requests r
     JOIN carrier_space_listings l ON l.id = r.listing_id
     JOIN users u ON u.id = l.carrier_id
     LEFT JOIN loads ld ON ld.id = r.load_id
     WHERE r.shipper_id = $1 AND ${REQUEST_SENT_OPS_SQL}
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
      `SELECT r.id, r.listing_id, r.shipper_id, r.requested_kg, r.status, r.message, r.load_id,
              l.carrier_id, l.remaining_space_kg, l.origin, l.destination,
              l.vehicle_type, l.rate_per_kg, l.available_from
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

    if (nextStatus === "active") {
      const rem = Number(row.remaining_space_kg);
      if (Number(row.requested_kg) > rem) {
        await client.query("ROLLBACK");
        return sendError(res, 409, "Insufficient remaining capacity");
      }
      await client.query(
        `UPDATE carrier_space_listings
         SET remaining_space_kg = remaining_space_kg - $2,
             status = CASE WHEN remaining_space_kg - $2 <= 0 THEN 'closed' ELSE status END,
             updated_at = now()
         WHERE id = $1`,
        [row.listing_id, row.requested_kg]
      );
    }

    let shipmentBridge = null;
    if (nextStatus === "active" && !row.load_id) {
      shipmentBridge = await createShipmentFromCapacityAccept(client, row, {
        carrier_id: row.carrier_id,
        origin: row.origin,
        destination: row.destination,
        vehicle_type: row.vehicle_type,
        rate_per_kg: row.rate_per_kg,
        available_from: row.available_from
      });
    }

    const dbStatus = nextStatus;

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
      active: ["SPACE_ACCEPTED", "Your capacity request was accepted"],
      rejected: ["SPACE_REJECTED", "Your capacity request was declined"],
      in_transit: ["SPACE_IN_TRANSIT", "Shipment is in transit on shared capacity"],
      completed: ["SPACE_COMPLETED", "Capacity contract completed — leave a review"]
    };
    const [title, msgBase] = notifyMap[nextStatus] || ["SPACE_UPDATE", "Request updated"];
    const dispatchType = shipmentBridge ? "CONTRACT_STARTED" : title;
    const refSuffix = shipmentBridge?.loadCode ? ` (${shipmentBridge.loadCode})` : '';
    void notifyUser({
      receiverId: row.shipper_id,
      senderId: row.carrier_id,
      roleType: "shipper",
      title: dispatchType,
      type: dispatchType,
      message: `${msgBase}${refSuffix}: ${row.origin} → ${row.destination}`,
      entityId: requestId,
      eventVersion: nextStatus
    });

    if (shipmentBridge) {
      const contractPayload = {
        requestId,
        loadId: shipmentBridge.loadId,
        loadCode: shipmentBridge.loadCode,
        shipmentId: shipmentBridge.shipmentId
      };
      emitContractDispatch({
        eventId: newEventId(),
        type: "CONTRACT_STARTED",
        receiverId: row.shipper_id,
        roleType: "shipper",
        entityType: "space",
        entityId: requestId,
        payload: contractPayload
      });
      void notifyUser({
        receiverId: row.carrier_id,
        senderId: row.shipper_id,
        roleType: "carrier",
        title: "CONTRACT_STARTED",
        type: "CONTRACT_STARTED",
        message: `Capacity contract is now active${refSuffix}: ${row.origin} → ${row.destination}`,
        entityId: requestId,
        eventVersion: shipmentBridge.shipmentId || shipmentBridge.loadId
      });
      emitContractDispatch({
        eventId: newEventId(),
        type: "CONTRACT_STARTED",
        receiverId: row.carrier_id,
        roleType: "carrier",
        entityType: "space",
        entityId: requestId,
        payload: contractPayload
      });
    }

    void notifyAdmins({
      senderId: req.auth.userId,
      title,
      type: title,
      message: `[Platform] Capacity request ${requestId} → ${nextStatus}: ${row.origin} → ${row.destination}`,
      idempotencyKey: buildDedupeKey(["ADMIN", title, requestId, nextStatus])
    });

    void writeAudit({
      actorUserId: req.auth.userId,
      action: `space.${nextStatus}`,
      targetEntity: "space_request",
      targetId: requestId,
      metadata: {
        listingId: row.listing_id,
        shipperId: row.shipper_id,
        loadId: shipmentBridge?.loadId || row.load_id || null
      }
    });

    emitContractEntityDispatch({
      entityType: "space",
      entityId: requestId,
      type: dispatchType,
      eventId: newEventId(),
      payload: {
        requestId,
        status: dbStatus,
        loadId: shipmentBridge?.loadId || row.load_id || null,
        loadCode: shipmentBridge?.loadCode || null
      }
    });

    if (shipmentBridge?.shipmentId) {
      emitContractEntityDispatch({
        entityType: "shipment",
        entityId: shipmentBridge.shipmentId,
        type: "CONTRACT_STARTED",
        eventId: newEventId(),
        payload: {
          requestId,
          loadId: shipmentBridge.loadId,
          loadCode: shipmentBridge.loadCode,
          shipmentId: shipmentBridge.shipmentId
        }
      });
    }

    return sendSuccess(res, 200, {
      ok: true,
      status: dbStatus.toUpperCase(),
      loadId: shipmentBridge?.loadId || row.load_id || null,
      loadCode: shipmentBridge?.loadCode || null,
      shipmentId: shipmentBridge?.shipmentId || null
    });
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
  void notifyUser({
    receiverId: otherId,
    senderId: uid,
    roleType: receiverRole,
    title: nextStatus === "in_transit" ? "SPACE_IN_TRANSIT" : "SPACE_COMPLETED",
    type: nextStatus === "in_transit" ? "SPACE_IN_TRANSIT" : "SPACE_COMPLETED",
    message: `Status: ${nextStatus} — ${row.origin} → ${row.destination}`
  });
  void notifyAdmins({
    senderId: uid,
    title: nextStatus === "in_transit" ? "SPACE_IN_TRANSIT" : "SPACE_COMPLETED",
    type: nextStatus === "in_transit" ? "SPACE_IN_TRANSIT" : "SPACE_COMPLETED",
    message: `[Platform] Capacity request ${nextStatus}: ${row.origin} → ${row.destination}`,
    idempotencyKey: buildDedupeKey(["ADMIN", "SPACE", requestId, nextStatus])
  });
  void writeAudit({
    actorUserId: uid,
    action: `space.${nextStatus}`,
    targetEntity: "space_request",
    targetId: requestId,
    metadata: { origin: row.origin, destination: row.destination }
  });
  emitContractEntityDispatch({
    entityType: "space",
    entityId: requestId,
    type: nextStatus === "in_transit" ? "SPACE_IN_TRANSIT" : "SPACE_COMPLETED",
    eventId: newEventId(),
    payload: { requestId, status: nextStatus }
  });
  return sendSuccess(res, 200, { ok: true, status: nextStatus.toUpperCase() });
}

router.put(
  "/requests/:id/accept",
  protect,
  requireRole("carrier"),
  [param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid id"); })()))],
  validate,
  asyncHandler((req, res) => transitionRequest(req, res, "active"))
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
