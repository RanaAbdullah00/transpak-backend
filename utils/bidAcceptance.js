const { getPool } = require("../db/pool");
const {
  assertBidTransition,
  BID,
  normalizeBidStatus,
  isCounterOffered,
  ACTIVE_BID_STATUSES_SQL
} = require("./bidStateMachine");
const { assertNotSelfCommercial } = require("./selfExclusion");
const { createShipmentUnified, ensureShipmentBookedEvent } = require("./shipmentFactory");
const {
  emitBidStateChange,
  emitBidRefresh,
  emitBidAcceptMarketplaceFanout,
  BID_DISPATCH
} = require("./bidRealtime");
const { notifyAdmins } = require("./notifyEvent");
const { invalidateAdminDashboardCache } = require("./adminDashboardCache");
const { buildDedupeKey } = require("./realtimeDispatch");
const { writeAudit } = require("./auditLog");

async function acceptBidAndBook(bidId, actorUserId, { allowCarrierListedAccept = false } = {}) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: bidRows } = await client.query(
      `SELECT b.id, b.load_id, b.carrier_id, b.amount, b.status,
              b.suggested_amount AS suggested_amount, b.suggested_by AS suggested_by,
              l.id AS load_id_locked, l.code AS load_code, l.shipper_id, l.status AS load_status,
              l.accepted_bid_id, l.expected_price
       FROM bids b
       JOIN loads l ON l.id = b.load_id
       WHERE b.id = $1
       FOR UPDATE OF l, b`,
      [bidId]
    );
    const bid = bidRows[0];
    if (!bid) {
      await client.query("ROLLBACK");
      return { ok: false, status: 404, message: "Not found", code: "NOT_FOUND" };
    }

    const isShipperActor = String(bid.shipper_id) === String(actorUserId);
    const isCarrierActor = String(bid.carrier_id) === String(actorUserId);

    if (!isShipperActor && !(allowCarrierListedAccept && isCarrierActor)) {
      await client.query("ROLLBACK");
      return { ok: false, status: 403, message: "Forbidden", code: "FORBIDDEN" };
    }

    if (allowCarrierListedAccept && isCarrierActor) {
      const listed = Number(bid.expected_price);
      const offered = Number(bid.amount);
      if (!Number.isFinite(listed) || listed <= 0 || offered !== listed) {
        await client.query("ROLLBACK");
        return {
          ok: false,
          status: 409,
          message: "Listed fare accept requires bid amount to match load expected price",
          code: "LISTED_FARE_MISMATCH"
        };
      }
      if (normalizeBidStatus(bid.status) !== BID.PENDING_SHIPPER) {
        await client.query("ROLLBACK");
        return { ok: false, status: 409, message: "Bid is not pending", code: "BID_NOT_ACTIONABLE" };
      }
    }

    try {
      assertNotSelfCommercial({
        shipperId: bid.shipper_id,
        carrierId: bid.carrier_id,
        action: "accept a bid on"
      });
    } catch (e) {
      await client.query("ROLLBACK");
      return { ok: false, status: e.statusCode || 403, message: e.message, code: e.code };
    }

    if (bid.accepted_bid_id && String(bid.accepted_bid_id) !== String(bidId)) {
      await client.query("ROLLBACK");
      return { ok: false, status: 409, message: "This load is already booked", code: "LOAD_ALREADY_BOOKED" };
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
      return { ok: false, status: 409, message: "Another carrier was already accepted", code: "LOAD_ALREADY_BOOKED" };
    }

    if (normalizeBidStatus(bid.status) === BID.ACCEPTED) {
      await client.query("ROLLBACK");
      return { ok: true, status: 200, data: { id: bid.id, flowStatus: "ACCEPTED" }, message: "Already accepted" };
    }
    if (normalizeBidStatus(bid.status) === BID.REJECTED) {
      await client.query("ROLLBACK");
      return { ok: false, status: 409, message: "Bid is not actionable", code: "BID_NOT_ACTIONABLE" };
    }

    assertBidTransition(bid.status, BID.ACCEPTED);
    const bidSt = normalizeBidStatus(bid.status);
    if (bidSt === BID.COUNTER && bid.suggested_by === "shipper") {
      await client.query("ROLLBACK");
      return { ok: false, status: 409, message: "Awaiting carrier response to your offer" };
    }
    if (
      bidSt !== BID.PENDING_SHIPPER &&
      !(bidSt === BID.COUNTER && bid.suggested_by === "carrier")
    ) {
      await client.query("ROLLBACK");
      return { ok: false, status: 409, message: "Bid is not pending" };
    }
    if (bid.load_status !== "open") {
      await client.query("ROLLBACK");
      return { ok: false, status: 409, message: "Load is not open", code: "LOAD_NOT_OPEN" };
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
      return { ok: false, status: 409, message: "Load was booked by another request", code: "LOAD_ALREADY_BOOKED" };
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

    await createShipmentUnified(client, {
      loadId: bid.load_id,
      bookingId,
      mode: "booked_upsert"
    });
    await ensureShipmentBookedEvent(client, { loadId: bid.load_id, note: null });

    await client.query("COMMIT");

    invalidateAdminDashboardCache();

    void writeAudit({
      actorUserId,
      action: "bid.accepted",
      targetEntity: "bid",
      targetId: bidId,
      metadata: { loadId: bid.load_id, carrierId: bid.carrier_id, amount: effectiveAmount }
    });
    void writeAudit({
      actorUserId,
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
    emitBidRefresh(actorUserId, isCarrierActor ? "carrier" : "shipper", BID_DISPATCH.ACCEPTED, {
      bidId,
      loadId: bid.load_id,
      loadCode: bid.load_code || null
    });
    emitBidRefresh(bid.carrier_id, "carrier", BID_DISPATCH.ACCEPTED, {
      bidId,
      loadId: bid.load_id,
      loadCode: bid.load_code || null
    });

    void emitBidAcceptMarketplaceFanout({
      loadId: bid.load_id,
      winningBidId: bidId,
      winningCarrierId: bid.carrier_id,
      shipperId: bid.shipper_id,
      loadCode: bid.load_code || null
    });

    void notifyAdmins({
      senderId: actorUserId,
      title: "BID_ACCEPTED",
      type: "BID_ACCEPTED",
      message: `[Platform] Bid ${bidId} accepted — load ${bid.load_id} booked`,
      idempotencyKey: buildDedupeKey(["ADMIN", "BID_ACCEPTED", bidId])
    });

    const { rows: codeRows } = await client.query(
      `SELECT l.code AS "loadCode", l.id AS "loadId", s.id AS "shipmentId"
       FROM loads l
       LEFT JOIN shipments s ON s.load_id = l.id
       WHERE l.id = $1
       LIMIT 1`,
      [bid.load_id]
    );

    return {
      ok: true,
      status: 200,
      data: {
        ok: true,
        bookingId,
        loadId: bid.load_id,
        loadCode: codeRows[0]?.loadCode || null,
        shipmentId: codeRows[0]?.shipmentId || null,
        flowStatus: "ACCEPTED",
        loadFlowStatus: "ACTIVE"
      },
      message: "Accepted"
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    if (err.code === "INVALID_BID_TRANSITION" || err.code === "INVALID_BID_STATE") {
      return { ok: false, status: err.statusCode || 409, message: err.message, code: err.code };
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { acceptBidAndBook };
