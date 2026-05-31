const express = require("express");
const { body, param, validationResult } = require("express-validator");
const { protect, requireAnyRole, requireRole, validateViewAs } = require("../middleware/authMiddleware");
const {
  canMutateBidAsShipper,
  canMutateBidAsCarrier,
  sendForbidden,
  FORBIDDEN_CODES
} = require("../utils/resourceAuth");
const { sendSuccess, sendError } = require("../utils/apiResponse");
const { getPool, query } = require("../db/pool");
const {
  assertBidTransition,
  apiBidStatus,
  BID,
  normalizeBidStatus,
  isCounterOffered,
  isAwaitingShipper,
  ACTIVE_BID_STATUSES_SQL,
  COMMERCIAL_BID_VISIBLE_SQL,
  assertCounterLimit
} = require("../utils/bidStateMachine");
const { emitBidStateChange, emitBidRefresh, BID_DISPATCH } = require("../utils/bidRealtime");
const { notifyAdmins } = require("../utils/notifyEvent");
const { buildDedupeKey, emitEntityDispatch, newEventId } = require("../utils/realtimeDispatch");
const { validateBidPlacement, validateCounterBid } = require("../utils/matchingEngine");
const { bidsRouteLimiter } = require("../middleware/apiRateLimit");
const { resolveCommercialViewRole } = require("../utils/commercialViewRole");
const { assertNotSelfCommercial } = require("../utils/selfExclusion");
const { requireCarrierTruckReady } = require("../middleware/commercialGates");
const { writeAudit } = require("../utils/auditLog");
const { forbidAdminOnlyCommercial } = require("../middleware/forbidAdminOnlyCommercial");
const router = express.Router();

router.use(forbidAdminOnlyCommercial);

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

router.get("/", protect, requireAnyRole(["shipper", "carrier"]), validateViewAs(), async (req, res) => {
  const roles = req.auth?.roles || [];
  const viewAs = resolveCommercialViewRole(roles, req.commercialView);

  const loadId = req.query?.loadId ? String(req.query.loadId).trim() : "";
  const shipperLoadClause = loadId && isUuid(loadId) ? "AND b.load_id = $2" : "";

  if (viewAs === "carrier") {
    const { rows } = await query(
      `SELECT b.id, b.load_id AS "loadId", b.carrier_id AS "carrierId", b.amount,
              b.status, b.suggested_amount AS "suggestedAmount", b.suggested_by AS "suggestedBy",
              b.created_at AS "createdAt",
              NULL::text AS "carrierName",
              'Truck' AS "vehicleType"
       FROM bids b
       WHERE b.carrier_id = $1
         AND ${COMMERCIAL_BID_VISIBLE_SQL}
       ORDER BY b.created_at DESC
       LIMIT 500`,
      [req.auth.userId]
    );
    return sendSuccess(res, 200, rows);
  }

  if (viewAs === "shipper") {
    const params = [req.auth.userId];
    if (shipperLoadClause) params.push(loadId);
    const { rows } = await query(
      `SELECT b.id, b.load_id AS "loadId", b.carrier_id AS "carrierId", b.amount,
              b.status, b.suggested_amount AS "suggestedAmount", b.suggested_by AS "suggestedBy",
              b.created_at AS "createdAt",
              COALESCE(u.full_name, u.email, 'Carrier') AS "carrierName",
              'Truck' AS "vehicleType"
       FROM bids b
       JOIN loads l ON l.id = b.load_id
       JOIN users u ON u.id = b.carrier_id
       WHERE l.shipper_id = $1
         AND b.carrier_id <> l.shipper_id
         AND ${COMMERCIAL_BID_VISIBLE_SQL}
         ${shipperLoadClause}
       ORDER BY b.created_at DESC
       LIMIT 500`,
      params
    );
    return sendSuccess(res, 200, rows);
  }

  return sendError(res, 403, "No bid access for this account");
});

// Frontend convenience: /bids/mine for carriers
router.get("/mine", protect, requireRole("carrier"), async (req, res) => {
  const { rows } = await query(
    `SELECT b.id, b.load_id AS "loadId", l.code AS "loadCode", b.carrier_id AS "carrierId", b.amount,
            b.status, b.suggested_amount AS "suggestedAmount", b.suggested_by AS "suggestedBy",
            b.created_at AS "createdAt",
            NULL::text AS "carrierName",
            'Truck' AS "vehicleType"
     FROM bids b
     JOIN loads l ON l.id = b.load_id
     WHERE b.carrier_id = $1 AND l.shipper_id <> b.carrier_id
       AND ${COMMERCIAL_BID_VISIBLE_SQL}
     ORDER BY b.created_at DESC
     LIMIT 500`,
    [req.auth.userId]
  );
  return sendSuccess(res, 200, rows);
});

router.post(
  "/",
  protect,
  bidsRouteLimiter,
  requireRole("carrier"),
  requireCarrierTruckReady,
  [
    body("loadId").custom((v) => (isUuid(v) ? true : (() => { throw new Error("loadId is required"); })())),
    body("amount").toFloat().isFloat({ gt: 0 }).withMessage("amount must be greater than 0")
  ],
  validate,
  async (req, res) => {
    try {
    const { loadId, amount } = req.body || {};
    const { rows: loadRows } = await query(
      `SELECT id, shipper_id, status, weight, vehicle_type,
              deadline_hours, deadline_minutes, created_at
       FROM loads
       WHERE id = $1`,
      [loadId]
    );
    const load = loadRows[0];
    if (!load) return sendError(res, 404, "Not found", null, "NOT_FOUND");
    try {
      assertNotSelfCommercial({
        shipperId: load.shipper_id,
        carrierId: req.auth.userId,
        action: "bid on"
      });
    } catch (e) {
      return sendError(res, e.statusCode || 403, e.message, null, e.code);
    }
    const { rows: existing } = await query(
      `SELECT id, load_id AS "loadId", carrier_id AS "carrierId", amount, status,
              suggested_amount AS "suggestedAmount", suggested_by AS "suggestedBy",
              created_at AS "createdAt"
       FROM bids WHERE load_id = $1 AND carrier_id = $2`,
      [loadId, req.auth.userId]
    );

    const placement = await validateBidPlacement({
      carrierUserId: req.auth.userId,
      load,
      existingBid: existing[0] || null
    });
    if (!placement.ok) {
      return sendError(res, placement.status, placement.message, null, placement.code);
    }

    if (existing[0] && isAwaitingShipper(existing[0].status) && Number(existing[0].amount) === Number(amount)) {
      const bid = { ...existing[0], flowStatus: apiBidStatus(existing[0].status) };
      return sendSuccess(res, 200, bid, "Already submitted");
    }

    const { rows } = await query(
      `INSERT INTO bids (load_id, carrier_id, amount, status)
       VALUES ($1, $2, $3, 'pending_shipper_confirmation')
       ON CONFLICT (load_id, carrier_id) DO NOTHING
       RETURNING id, load_id AS "loadId", carrier_id AS "carrierId", amount, status,
                 suggested_amount AS "suggestedAmount", suggested_by AS "suggestedBy",
                 created_at AS "createdAt"`,
      [loadId, req.auth.userId, Number(amount)]
    );

    if (!rows[0]) {
      const { rows: again } = await query(
        `SELECT id, load_id AS "loadId", carrier_id AS "carrierId", amount, status,
                suggested_amount AS "suggestedAmount", suggested_by AS "suggestedBy",
                created_at AS "createdAt"
         FROM bids WHERE load_id = $1 AND carrier_id = $2`,
        [loadId, req.auth.userId]
      );
      if (again[0]) {
        const bid = { ...again[0], flowStatus: apiBidStatus(again[0].status) };
        return sendSuccess(res, 200, bid, "Already submitted");
      }
      return sendError(res, 409, "Active bid already exists on this load", null, "ACTIVE_BID_EXISTS");
    }

    const { rows: loadOwner } = await query(`SELECT shipper_id FROM loads WHERE id = $1`, [loadId]);
    if (loadOwner[0]?.shipper_id) {
      await emitBidStateChange({
        receiverId: loadOwner[0].shipper_id,
        senderId: req.auth.userId,
        roleType: "shipper",
        dispatchType: BID_DISPATCH.CREATED,
        title: "SHIPPER_CONFIRMATION_REQUEST",
        message: `Carrier bid PKR ${Number(amount)} — confirm to book`
      });
    }
    emitBidRefresh(req.auth.userId, "carrier", BID_DISPATCH.CREATED, { bidId: rows[0].id, loadId });
    emitEntityDispatch({
      entityType: "bid",
      entityId: rows[0].id,
      type: BID_DISPATCH.CREATED,
      eventId: newEventId(),
      payload: { bidId: rows[0].id, loadId }
    });

    void writeAudit({
      actorUserId: req.auth.userId,
      action: "bid.created",
      targetEntity: "bid",
      targetId: rows[0].id,
      metadata: { loadId, amount: Number(amount) }
    });

    void notifyAdmins({
      senderId: req.auth.userId,
      title: "BID_CREATED",
      type: "BID_CREATED",
      message: `[Platform] New bid PKR ${Number(amount)} on load ${loadId}`,
      idempotencyKey: buildDedupeKey(["ADMIN", "BID_CREATED", rows[0].id])
    });

    const bid = { ...rows[0], flowStatus: apiBidStatus(rows[0].status) };
    return sendSuccess(res, 201, bid, "Created");
    } catch (err) {
      if (err.code === "COUNTER_LIMIT_REACHED") {
        return sendError(res, err.statusCode || 409, err.message, null, err.code);
      }
      return sendError(res, 500, err.message || "Server error", null, "SERVER_ERROR");
    }
  }
);

router.put(
  "/:id/reject",
  protect,
  requireRole("shipper"),
  [param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid bid id"); })()))],
  validate,
  async (req, res) => {
    try {
      const bidId = req.params.id;
      const { rows: bidRows } = await query(
        `SELECT b.id, b.load_id, b.status, l.shipper_id
         FROM bids b JOIN loads l ON l.id = b.load_id
         WHERE b.id = $1`,
        [bidId]
      );
      const bid = bidRows[0];
      if (!bid) return sendError(res, 404, "Not found");
      if (!canMutateBidAsShipper(bid, req.auth)) {
        return sendForbidden(res, "Forbidden", FORBIDDEN_CODES.FORBIDDEN_OWNER);
      }
      assertBidTransition(bid.status, BID.REJECTED);
      await query(`UPDATE bids SET status = 'rejected', updated_at = now() WHERE id = $1`, [bidId]);
      const { rows: bidMeta } = await query(`SELECT carrier_id FROM bids WHERE id = $1`, [bidId]);
      if (bidMeta[0]?.carrier_id) {
        await emitBidStateChange({
          receiverId: bidMeta[0].carrier_id,
          senderId: req.auth.userId,
          roleType: "carrier",
          dispatchType: BID_DISPATCH.REJECTED,
          title: "BID_REJECTED",
          message: "Your bid was declined by the shipper"
        });
      }
      emitBidRefresh(req.auth.userId, "shipper", BID_DISPATCH.REJECTED, { bidId });
      void notifyAdmins({
        senderId: req.auth.userId,
        title: "BID_REJECTED",
        type: "BID_REJECTED",
        message: `[Platform] Bid ${bidId} rejected on load ${bid.load_id}`,
        idempotencyKey: buildDedupeKey(["ADMIN", "BID_REJECTED", bidId])
      });
      void writeAudit({
        actorUserId: req.auth.userId,
        action: "bid.rejected",
        targetEntity: "bid",
        targetId: bidId,
        metadata: { loadId: bid.load_id }
      });
      return sendSuccess(res, 200, { ok: true, flowStatus: "REJECTED", status: "rejected" }, "Rejected");
    } catch (err) {
      if (err.code === "INVALID_BID_TRANSITION" || err.code === "INVALID_BID_STATE") {
        return sendError(res, err.statusCode || 409, err.message, null, err.code);
      }
      return sendError(res, 500, err.message || "Server error", null, "SERVER_ERROR");
    }
  }
);

router.put(
  "/:id/suggest",
  protect,
  requireRole("shipper"),
  [
    param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid bid id"); })())),
    body("amount").toFloat().isFloat({ gt: 0 }).withMessage("amount must be greater than 0")
  ],
  validate,
  async (req, res) => {
    try {
      const bidId = req.params.id;
      const amount = Number(req.body.amount);
      const { rows: bidRows } = await query(
        `SELECT b.id, b.load_id, b.status, b.carrier_id, b.counter_round_count, l.shipper_id,
                l.status AS load_status, l.weight, l.vehicle_type,
                l.deadline_hours, l.deadline_minutes, l.created_at
         FROM bids b JOIN loads l ON l.id = b.load_id
         WHERE b.id = $1`,
        [bidId]
      );
      const bid = bidRows[0];
      if (!bid) return sendError(res, 404, "Not found");
      if (!canMutateBidAsShipper(bid, req.auth)) {
        return sendForbidden(res, "Forbidden", FORBIDDEN_CODES.FORBIDDEN_OWNER);
      }
      const load = {
        status: bid.load_status,
        weight: bid.weight,
        vehicle_type: bid.vehicle_type,
        deadline_hours: bid.deadline_hours,
        deadline_minutes: bid.deadline_minutes,
        created_at: bid.created_at
      };
      const counterCheck = await validateCounterBid({
        actorRole: "shipper",
        carrierUserId: bid.carrier_id,
        bid,
        load
      });
      if (!counterCheck.ok) {
        return sendError(res, counterCheck.status, counterCheck.message, null, counterCheck.code);
      }
      assertBidTransition(bid.status, BID.COUNTER);
      assertCounterLimit(bid.counter_round_count);
      await query(
        `UPDATE bids
         SET status = 'counter_offered', suggested_amount = $2, suggested_by = 'shipper',
             counter_round_count = counter_round_count + 1, updated_at = now()
         WHERE id = $1`,
        [bidId, amount]
      );
      await emitBidStateChange({
        receiverId: bid.carrier_id,
        senderId: req.auth.userId,
        roleType: "carrier",
        dispatchType: BID_DISPATCH.COUNTER,
        title: "COUNTER_OFFERED",
        message: `Shipper counter offer: PKR ${amount}`
      });
      emitBidRefresh(req.auth.userId, "shipper", BID_DISPATCH.COUNTER, { bidId });
      void notifyAdmins({
        senderId: req.auth.userId,
        title: "BID_COUNTER",
        type: "BID_COUNTER",
        message: `[Platform] Shipper counter offer PKR ${amount} on bid ${bidId}`,
        idempotencyKey: buildDedupeKey(["ADMIN", "BID_COUNTER", bidId, "shipper"])
      });
      void writeAudit({
        actorUserId: req.auth.userId,
        action: "bid.countered",
        targetEntity: "bid",
        targetId: bidId,
        metadata: { by: "shipper", amount }
      });
      return sendSuccess(res, 200, { ok: true, flowStatus: "COUNTER_OFFERED" }, "Suggested");
    } catch (err) {
      if (
        err.code === "INVALID_BID_TRANSITION" ||
        err.code === "INVALID_BID_STATE" ||
        err.code === "COUNTER_LIMIT_REACHED"
      ) {
        return sendError(res, err.statusCode || 409, err.message, null, err.code);
      }
      return sendError(res, 500, err.message || "Server error", null, "SERVER_ERROR");
    }
  }
);

router.put(
  "/:id/suggest-carrier",
  protect,
  requireRole("carrier"),
  requireCarrierTruckReady,
  [
    param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid bid id"); })())),
    body("amount").toFloat().isFloat({ gt: 0 }).withMessage("amount must be greater than 0")
  ],
  validate,
  async (req, res) => {
    try {
      const bidId = req.params.id;
      const amount = Number(req.body.amount);
      const { rows: bidRows } = await query(
        `SELECT b.id, b.carrier_id, b.status, b.suggested_amount, b.suggested_by, b.counter_round_count,
                l.shipper_id, l.status AS load_status, l.weight, l.vehicle_type,
                l.deadline_hours, l.deadline_minutes, l.created_at
         FROM bids b JOIN loads l ON l.id = b.load_id
         WHERE b.id = $1`,
        [bidId]
      );
      const bid = bidRows[0];
      if (!bid) return sendError(res, 404, "Not found", null, "NOT_FOUND");
      if (!canMutateBidAsCarrier(bid, req.auth)) {
        return sendForbidden(res, "Forbidden", FORBIDDEN_CODES.FORBIDDEN_OWNER);
      }
      const load = {
        status: bid.load_status,
        weight: bid.weight,
        vehicle_type: bid.vehicle_type,
        deadline_hours: bid.deadline_hours,
        deadline_minutes: bid.deadline_minutes,
        created_at: bid.created_at
      };
      const counterCheck = await validateCounterBid({
        actorRole: "carrier",
        carrierUserId: req.auth.userId,
        bid,
        load
      });
      if (!counterCheck.ok) {
        return sendError(res, counterCheck.status, counterCheck.message, null, counterCheck.code);
      }
      const st = normalizeBidStatus(bid.status);
      if (st === BID.ACCEPTED) {
        return sendError(res, 409, "Bid is already accepted", null, "BID_ALREADY_ACCEPTED");
      }
      if (
        st === BID.COUNTER &&
        bid.suggested_by === "carrier" &&
        Number(bid.suggested_amount) === Number(amount)
      ) {
        return sendSuccess(res, 200, { ok: true, flowStatus: "COUNTER_OFFERED" }, "Already suggested");
      }
      assertBidTransition(bid.status, BID.COUNTER);
      assertCounterLimit(bid.counter_round_count);
      await query(
        `UPDATE bids
         SET status = 'counter_offered', suggested_amount = $2, suggested_by = 'carrier',
             counter_round_count = counter_round_count + 1, updated_at = now()
         WHERE id = $1`,
        [bidId, amount]
      );
      await emitBidStateChange({
        receiverId: bid.shipper_id,
        senderId: req.auth.userId,
        roleType: "shipper",
        dispatchType: BID_DISPATCH.COUNTER,
        title: "COUNTER_OFFERED",
        message: `Carrier counter offer: PKR ${amount}`
      });
      emitBidRefresh(req.auth.userId, "carrier", BID_DISPATCH.COUNTER, { bidId });
      void notifyAdmins({
        senderId: req.auth.userId,
        title: "BID_COUNTER",
        type: "BID_COUNTER",
        message: `[Platform] Carrier counter offer PKR ${amount} on bid ${bidId}`,
        idempotencyKey: buildDedupeKey(["ADMIN", "BID_COUNTER", bidId, "carrier"])
      });
      void writeAudit({
        actorUserId: req.auth.userId,
        action: "bid.countered",
        targetEntity: "bid",
        targetId: bidId,
        metadata: { by: "carrier", amount }
      });
      return sendSuccess(res, 200, { ok: true, flowStatus: "COUNTER_OFFERED" }, "Suggested");
    } catch (err) {
      if (
        err.code === "INVALID_BID_TRANSITION" ||
        err.code === "INVALID_BID_STATE" ||
        err.code === "COUNTER_LIMIT_REACHED"
      ) {
        return sendError(res, err.statusCode || 409, err.message, null, err.code);
      }
      return sendError(res, 500, err.message || "Server error", null, "SERVER_ERROR");
    }
  }
);

router.put(
  "/:id/accept-suggestion",
  protect,
  requireRole("carrier"),
  requireCarrierTruckReady,
  [param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid bid id"); })()))],
  validate,
  async (req, res) => {
    const bidId = req.params.id;
    const { rows } = await query(
      `UPDATE bids
       SET amount = COALESCE(suggested_amount, amount),
           suggested_amount = NULL,
           suggested_by = NULL,
           status = 'pending_shipper_confirmation',
           updated_at = now()
       WHERE id = $1 AND carrier_id = $2
       RETURNING id`,
      [bidId, req.auth.userId]
    );
    if (!rows[0]) return sendError(res, 404, "Not found");
    const { rows: meta } = await query(
      `SELECT b.carrier_id, l.shipper_id, b.amount
       FROM bids b JOIN loads l ON l.id = b.load_id WHERE b.id = $1`,
      [bidId]
    );
    if (meta[0]?.shipper_id) {
      await emitBidStateChange({
        receiverId: meta[0].shipper_id,
        senderId: req.auth.userId,
        roleType: "shipper",
        dispatchType: BID_DISPATCH.UPDATED,
        title: "SHIPPER_CONFIRMATION_REQUEST",
        message: `Carrier accepted your counter — PKR ${Number(meta[0].amount || 0)}`
      });
    }
    emitBidRefresh(req.auth.userId, "carrier", BID_DISPATCH.UPDATED, { bidId });
    return sendSuccess(res, 200, { ok: true, flowStatus: "PENDING_SHIPPER_CONFIRMATION" }, "Accepted");
  }
);

router.put(
  "/:id/reject-suggestion",
  protect,
  requireRole("carrier"),
  [param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid bid id"); })()))],
  validate,
  async (req, res) => {
    const bidId = req.params.id;
    const { rows } = await query(
      `UPDATE bids
       SET suggested_amount = NULL, suggested_by = NULL, status = 'pending_shipper_confirmation', updated_at = now()
       WHERE id = $1 AND carrier_id = $2
       RETURNING id`,
      [bidId, req.auth.userId]
    );
    if (!rows[0]) return sendError(res, 404, "Not found");
    const { rows: meta } = await query(
      `SELECT b.carrier_id, l.shipper_id
       FROM bids b JOIN loads l ON l.id = b.load_id WHERE b.id = $1`,
      [bidId]
    );
    if (meta[0]?.shipper_id) {
      await emitBidStateChange({
        receiverId: meta[0].shipper_id,
        senderId: req.auth.userId,
        roleType: "shipper",
        dispatchType: BID_DISPATCH.UPDATED,
        title: "BID_UPDATED",
        message: "Carrier declined your counter offer"
      });
    }
    emitBidRefresh(req.auth.userId, "carrier", BID_DISPATCH.UPDATED, { bidId });
    return sendSuccess(res, 200, { ok: true, flowStatus: "PENDING_SHIPPER_CONFIRMATION" }, "Rejected");
  }
);

router.put(
  "/:id/accept",
  protect,
  requireRole("shipper"),
  [param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid bid id"); })()))],
  validate,
  async (req, res) => {
    const bidId = req.params.id;
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const { rows: bidRows } = await client.query(
        `SELECT b.id, b.load_id, b.carrier_id, b.amount, b.status,
                b.suggested_amount AS suggested_amount, b.suggested_by AS suggested_by,
                l.id AS load_id_locked, l.shipper_id, l.status AS load_status, l.accepted_bid_id
         FROM bids b
         JOIN loads l ON l.id = b.load_id
         WHERE b.id = $1
         FOR UPDATE OF l, b`,
        [bidId]
      );
      const bid = bidRows[0];
      if (!bid) {
        await client.query("ROLLBACK");
        return sendError(res, 404, "Not found");
      }

      if (!canMutateBidAsShipper(bid, req.auth)) {
        await client.query("ROLLBACK");
        return sendForbidden(res, "Forbidden", FORBIDDEN_CODES.FORBIDDEN_OWNER);
      }

      try {
        assertNotSelfCommercial({
          shipperId: bid.shipper_id,
          carrierId: bid.carrier_id,
          action: "accept a bid on"
        });
      } catch (e) {
        await client.query("ROLLBACK");
        return sendError(res, e.statusCode || 403, e.message, null, e.code);
      }

      if (bid.accepted_bid_id && String(bid.accepted_bid_id) !== String(bidId)) {
        await client.query("ROLLBACK");
        return sendError(res, 409, "This load is already booked", null, "LOAD_ALREADY_BOOKED");
      }

      const { rows: otherAccepted } = await client.query(
        `SELECT id FROM bids
         WHERE load_id = $1 AND status = 'accepted' AND id <> $2
         LIMIT 1
         FOR UPDATE`,
        [bid.load_id, bidId]
      );
      if (otherAccepted[0]) {
        await client.query("ROLLBACK");
        return sendError(res, 409, "Another carrier was already accepted", null, "LOAD_ALREADY_BOOKED");
      }

      if (normalizeBidStatus(bid.status) === BID.ACCEPTED) {
        await client.query("ROLLBACK");
        return sendSuccess(res, 200, { id: bid.id, flowStatus: "ACCEPTED" }, "Already accepted");
      }
      if (normalizeBidStatus(bid.status) === BID.REJECTED) {
        await client.query("ROLLBACK");
        return sendError(res, 409, "Bid is not actionable", null, "BID_NOT_ACTIONABLE");
      }
      assertBidTransition(bid.status, BID.ACCEPTED);
      const bidSt = normalizeBidStatus(bid.status);
      if (bidSt === BID.COUNTER && bid.suggested_by === "shipper") {
        await client.query("ROLLBACK");
        return sendError(res, 409, "Awaiting carrier response to your offer");
      }
      if (
        bidSt !== BID.PENDING_SHIPPER &&
        !(bidSt === BID.COUNTER && bid.suggested_by === "carrier")
      ) {
        await client.query("ROLLBACK");
        return sendError(res, 409, "Bid is not pending");
      }
      if (bid.load_status !== "open") {
        await client.query("ROLLBACK");
        return sendError(res, 409, "Load is not open", null, "LOAD_NOT_OPEN");
      }

      let effectiveAmount = Number(bid.amount);
      if (isCounterOffered(bid.status) && bid.suggested_by === "carrier" && bid.suggested_amount != null) {
        effectiveAmount = Number(bid.suggested_amount);
      }

      const { rows: loadBooked } = await client.query(
        `UPDATE loads
         SET assigned_carrier_id = $2,
             accepted_bid_id = $3,
             status = 'booked',
             updated_at = now()
         WHERE id = $1
           AND status = 'open'
           AND (accepted_bid_id IS NULL OR accepted_bid_id = $3)
         RETURNING id`,
        [bid.load_id, bid.carrier_id, bidId]
      );
      if (!loadBooked[0]) {
        await client.query("ROLLBACK");
        return sendError(res, 409, "Load was booked by another request", null, "LOAD_ALREADY_BOOKED");
      }

      await client.query(
        `UPDATE bids
         SET status = 'accepted',
             amount = $2,
             suggested_amount = NULL,
             suggested_by = NULL,
             updated_at = now()
         WHERE id = $1`,
        [bidId, effectiveAmount]
      );
      await client.query(
        `UPDATE bids SET status = 'rejected', updated_at = now()
         WHERE load_id = $1 AND id <> $2 AND status IN ${ACTIVE_BID_STATUSES_SQL}`,
        [bid.load_id, bidId]
      );

      const { rows: bookingRows } = await client.query(
        `INSERT INTO bookings (load_id, shipper_id, carrier_id, status, price)
         VALUES ($1, $2, $3, 'approved', $4)
         ON CONFLICT (load_id)
         DO UPDATE SET carrier_id = EXCLUDED.carrier_id, status = 'approved', price = EXCLUDED.price, updated_at = now()
         RETURNING id`,
        [bid.load_id, bid.shipper_id, bid.carrier_id, effectiveAmount]
      );
      const bookingId = bookingRows[0]?.id;

      await client.query(
        `INSERT INTO shipments (load_id, booking_id, status, location_unavailable)
         VALUES ($1, $2, 'booked', true)
         ON CONFLICT (load_id)
         DO UPDATE SET booking_id = EXCLUDED.booking_id, status = 'booked', updated_at = now()`,
        [bid.load_id, bookingId]
      );

      await client.query(
        `INSERT INTO shipment_events (shipment_id, status, note, location_label)
         SELECT s.id, 'booked', NULL, 'System'
         FROM shipments s
         WHERE s.load_id = $1
           AND NOT EXISTS (
             SELECT 1 FROM shipment_events e
             WHERE e.shipment_id = s.id AND e.status = 'booked'
           )`,
        [bid.load_id]
      );

      await client.query("COMMIT");

      void writeAudit({
        actorUserId: req.auth.userId,
        action: "bid.accepted",
        targetEntity: "bid",
        targetId: bidId,
        metadata: { loadId: bid.load_id, carrierId: bid.carrier_id, amount: effectiveAmount }
      });
      void writeAudit({
        actorUserId: req.auth.userId,
        action: "shipment.started",
        targetEntity: "load",
        targetId: bid.load_id,
        metadata: { bidId, bookingId }
      });

      void emitBidStateChange({
        receiverId: bid.carrier_id,
        senderId: bid.shipper_id,
        roleType: "carrier",
        dispatchType: BID_DISPATCH.ACCEPTED,
        title: "BID_ACCEPTED",
        message: "Your bid was accepted. Contract is active."
      });
      void emitBidStateChange({
        receiverId: bid.shipper_id,
        senderId: bid.carrier_id,
        roleType: "shipper",
        dispatchType: BID_DISPATCH.ACCEPTED,
        title: "CONTRACT_STARTED",
        message: "Load booked. You can now contact the carrier."
      });
      emitBidRefresh(req.auth.userId, "shipper", BID_DISPATCH.ACCEPTED, { bidId, loadId: bid.load_id });

      void notifyAdmins({
        senderId: req.auth.userId,
        title: "BID_ACCEPTED",
        type: "BID_ACCEPTED",
        message: `[Platform] Bid ${bidId} accepted — load ${bid.load_id} booked`,
        idempotencyKey: buildDedupeKey(["ADMIN", "BID_ACCEPTED", bidId])
      });

      return sendSuccess(res, 200, { ok: true, bookingId, flowStatus: "ACCEPTED", loadFlowStatus: "ACTIVE" }, "Accepted");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore
      }
      if (err.code === "INVALID_BID_TRANSITION" || err.code === "INVALID_BID_STATE") {
        return sendError(res, err.statusCode || 409, err.message, { code: err.code });
      }
      return sendError(res, 500, err.message || "Server error");
    } finally {
      client.release();
    }
  }
);

module.exports = router;
