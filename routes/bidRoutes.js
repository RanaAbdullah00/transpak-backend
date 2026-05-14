const express = require("express");
const { body, param, validationResult } = require("express-validator");
const { protect, requireAnyRole, requireActiveRole } = require("../middleware/authMiddleware");
const { sendSuccess, sendError } = require("../utils/apiResponse");
const { getPool, query } = require("../db/pool");

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

router.get("/", protect, requireAnyRole(["shipper", "carrier", "admin"]), async (req, res) => {
  const roles = req.auth?.roles || [];
  const active = req.auth?.activeRole;
  const isAdmin = roles.includes("admin");
  const viewAs =
    active === "shipper" || active === "carrier"
      ? active
      : roles.includes("shipper")
      ? "shipper"
      : roles.includes("carrier")
      ? "carrier"
      : null;

  const loadId = req.query?.loadId ? String(req.query.loadId).trim() : "";
  const adminLoadFilter = loadId && isUuid(loadId) ? "AND b.load_id = $1" : "";
  const shipperLoadClause = loadId && isUuid(loadId) ? "AND b.load_id = $2" : "";

  if (isAdmin) {
    const adminParams = adminLoadFilter ? [loadId] : [];
    const { rows } = await query(
      `SELECT b.id, b.load_id AS "loadId", b.carrier_id AS "carrierId", b.amount,
              b.status, b.created_at AS "createdAt",
              COALESCE(u.full_name, u.email, 'Carrier') AS "carrierName",
              'Truck' AS "vehicleType"
       FROM bids b
       JOIN users u ON u.id = b.carrier_id
       WHERE 1=1 ${adminLoadFilter}
       ORDER BY b.created_at DESC
       LIMIT 500`,
      adminParams
    );
    return sendSuccess(res, 200, rows);
  }

  if (active === "carrier") {
    const { rows } = await query(
      `SELECT b.id, b.load_id AS "loadId", b.carrier_id AS "carrierId", b.amount,
              b.status, b.suggested_amount AS "suggestedAmount", b.suggested_by AS "suggestedBy",
              b.created_at AS "createdAt",
              NULL::text AS "carrierName",
              'Truck' AS "vehicleType"
       FROM bids b
       WHERE b.carrier_id = $1
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
       WHERE l.shipper_id = $1 ${shipperLoadClause}
       ORDER BY b.created_at DESC
       LIMIT 500`,
      params
    );
    return sendSuccess(res, 200, rows);
  }

  return sendError(res, 403, "No bid access for this account");
});

// Frontend convenience: /bids/mine for carriers
router.get("/mine", protect, requireAnyRole(["carrier", "admin"]), async (req, res) => {
  const roles = req.auth?.roles || [];
  if (!roles.includes("carrier") && !roles.includes("admin")) {
    return sendError(res, 403, "Carrier role required");
  }
  const { rows } = await query(
    `SELECT b.id, b.load_id AS "loadId", b.carrier_id AS "carrierId", b.amount,
            b.status, b.suggested_amount AS "suggestedAmount", b.suggested_by AS "suggestedBy",
            b.created_at AS "createdAt",
            NULL::text AS "carrierName",
            'Truck' AS "vehicleType"
     FROM bids b
     WHERE b.carrier_id = $1
     ORDER BY b.created_at DESC
     LIMIT 500`,
    [req.auth.userId]
  );
  return sendSuccess(res, 200, rows);
});

router.post(
  "/",
  protect,
  requireAnyRole(["carrier", "admin"]),
  requireActiveRole("carrier"),
  [
    body("loadId").custom((v) => (isUuid(v) ? true : (() => { throw new Error("loadId is required"); })())),
    body("amount").toFloat().isFloat({ gt: 0 }).withMessage("amount must be greater than 0")
  ],
  validate,
  async (req, res) => {
    const { loadId, amount } = req.body || {};
    const { rows: loadRows } = await query(
      `SELECT id, status, deadline_hours
       FROM loads
       WHERE id = $1`,
      [loadId]
    );
    const load = loadRows[0];
    if (!load) return sendError(res, 404, "Not found");
    if (load.status !== "open") return sendError(res, 409, "Load is not open for bidding");

    const { rows } = await query(
      `INSERT INTO bids (load_id, carrier_id, amount, status)
       VALUES ($1, $2, $3, 'pending')
       ON CONFLICT (load_id, carrier_id)
         DO UPDATE SET amount = EXCLUDED.amount, status = 'pending', suggested_amount = NULL, suggested_by = NULL, updated_at = now()
         RETURNING id, load_id AS "loadId", carrier_id AS "carrierId", amount, status,
                   suggested_amount AS "suggestedAmount", suggested_by AS "suggestedBy",
                   created_at AS "createdAt"`,
      [loadId, req.auth.userId, Number(amount)]
    );

    return sendSuccess(res, 201, rows[0], "Created");
  }
);

router.put(
  "/:id/reject",
  protect,
  requireAnyRole(["shipper", "admin"]),
  requireActiveRole("shipper"),
  [param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid bid id"); })()))],
  validate,
  async (req, res) => {
    const bidId = req.params.id;
    const { rows: bidRows } = await query(
      `SELECT b.id, b.load_id, b.status, l.shipper_id
       FROM bids b JOIN loads l ON l.id = b.load_id
       WHERE b.id = $1`,
      [bidId]
    );
    const bid = bidRows[0];
    if (!bid) return sendError(res, 404, "Not found");
    if (String(bid.shipper_id) !== String(req.auth.userId) && !(req.auth.roles || []).includes("admin")) {
      return sendError(res, 403, "Forbidden");
    }
    await query(`UPDATE bids SET status = 'rejected', updated_at = now() WHERE id = $1`, [bidId]);
    return sendSuccess(res, 200, { ok: true }, "Rejected");
  }
);

router.put(
  "/:id/suggest",
  protect,
  requireAnyRole(["shipper", "admin"]),
  requireActiveRole("shipper"),
  [
    param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid bid id"); })())),
    body("amount").toFloat().isFloat({ gt: 0 }).withMessage("amount must be greater than 0")
  ],
  validate,
  async (req, res) => {
    const bidId = req.params.id;
    const amount = Number(req.body.amount);
    const { rows: bidRows } = await query(
      `SELECT b.id, b.load_id, l.shipper_id
       FROM bids b JOIN loads l ON l.id = b.load_id
       WHERE b.id = $1`,
      [bidId]
    );
    const bid = bidRows[0];
    if (!bid) return sendError(res, 404, "Not found");
    if (String(bid.shipper_id) !== String(req.auth.userId) && !(req.auth.roles || []).includes("admin")) {
      return sendError(res, 403, "Forbidden");
    }
    await query(
      `UPDATE bids
       SET status = 'suggested', suggested_amount = $2, suggested_by = 'shipper', updated_at = now()
       WHERE id = $1`,
      [bidId, amount]
    );
    return sendSuccess(res, 200, { ok: true }, "Suggested");
  }
);

router.put(
  "/:id/suggest-carrier",
  protect,
  requireAnyRole(["carrier", "admin"]),
  requireActiveRole("carrier"),
  [
    param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid bid id"); })())),
    body("amount").toFloat().isFloat({ gt: 0 }).withMessage("amount must be greater than 0")
  ],
  validate,
  async (req, res) => {
    const bidId = req.params.id;
    const amount = Number(req.body.amount);
    const { rows: bidRows } = await query(`SELECT id, carrier_id FROM bids WHERE id = $1`, [bidId]);
    const bid = bidRows[0];
    if (!bid) return sendError(res, 404, "Not found");
    if (String(bid.carrier_id) !== String(req.auth.userId) && !(req.auth.roles || []).includes("admin")) {
      return sendError(res, 403, "Forbidden");
    }
    await query(
      `UPDATE bids
       SET status = 'suggested', suggested_amount = $2, suggested_by = 'carrier', updated_at = now()
       WHERE id = $1`,
      [bidId, amount]
    );
    return sendSuccess(res, 200, { ok: true }, "Suggested");
  }
);

router.put(
  "/:id/accept-suggestion",
  protect,
  requireAnyRole(["carrier", "admin"]),
  requireActiveRole("carrier"),
  [param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid bid id"); })()))],
  validate,
  async (req, res) => {
    const bidId = req.params.id;
    const { rows } = await query(
      `UPDATE bids
       SET amount = COALESCE(suggested_amount, amount),
           suggested_amount = NULL,
           suggested_by = NULL,
           status = 'pending',
           updated_at = now()
       WHERE id = $1 AND carrier_id = $2
       RETURNING id`,
      [bidId, req.auth.userId]
    );
    if (!rows[0]) return sendError(res, 404, "Not found");
    return sendSuccess(res, 200, { ok: true }, "Accepted");
  }
);

router.put(
  "/:id/reject-suggestion",
  protect,
  requireAnyRole(["carrier", "admin"]),
  requireActiveRole("carrier"),
  [param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid bid id"); })()))],
  validate,
  async (req, res) => {
    const bidId = req.params.id;
    const { rows } = await query(
      `UPDATE bids
       SET suggested_amount = NULL, suggested_by = NULL, status = 'pending', updated_at = now()
       WHERE id = $1 AND carrier_id = $2
       RETURNING id`,
      [bidId, req.auth.userId]
    );
    if (!rows[0]) return sendError(res, 404, "Not found");
    return sendSuccess(res, 200, { ok: true }, "Rejected");
  }
);

router.put(
  "/:id/accept",
  protect,
  requireAnyRole(["shipper", "admin"]),
  requireActiveRole("shipper"),
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
                l.shipper_id, l.status AS load_status
         FROM bids b
         JOIN loads l ON l.id = b.load_id
         WHERE b.id = $1
         FOR UPDATE`,
        [bidId]
      );
      const bid = bidRows[0];
      if (!bid) {
        await client.query("ROLLBACK");
        return sendError(res, 404, "Not found");
      }
      if (bid.status === "rejected" || bid.status === "accepted") {
        await client.query("ROLLBACK");
        return sendError(res, 409, "Bid is not actionable");
      }
      if (bid.status === "suggested" && bid.suggested_by === "shipper") {
        await client.query("ROLLBACK");
        return sendError(res, 409, "Awaiting carrier response to your offer");
      }
      if (bid.status !== "pending" && bid.status !== "suggested") {
        await client.query("ROLLBACK");
        return sendError(res, 409, "Bid is not pending");
      }
      if (String(bid.shipper_id) !== String(req.auth.userId) && !(req.auth.roles || []).includes("admin")) {
        await client.query("ROLLBACK");
        return sendError(res, 403, "Forbidden");
      }
      if (bid.load_status !== "open") {
        await client.query("ROLLBACK");
        return sendError(res, 409, "Load is not open");
      }

      await client.query(
        `INSERT INTO shipments (load_id, status, location_unavailable)
         VALUES ($1, 'posted', true)
         ON CONFLICT (load_id) DO NOTHING`,
        [bid.load_id]
      );

      let effectiveAmount = Number(bid.amount);
      if (bid.status === "suggested" && bid.suggested_by === "carrier" && bid.suggested_amount != null) {
        effectiveAmount = Number(bid.suggested_amount);
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
         WHERE load_id = $1 AND id <> $2 AND status IN ('pending', 'suggested')`,
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
        `UPDATE loads
         SET assigned_carrier_id = $2, accepted_bid_id = $3, status = 'booked', updated_at = now()
         WHERE id = $1`,
        [bid.load_id, bid.carrier_id, bidId]
      );
      await client.query(
        `UPDATE shipments
         SET booking_id = $2, status = 'booked', updated_at = now()
         WHERE load_id = $1`,
        [bid.load_id, bookingId]
      );
      await client.query(
        `INSERT INTO shipment_events (shipment_id, status, note, location_label)
         SELECT s.id, 'booked', NULL, 'System' FROM shipments s WHERE s.load_id = $1`,
        [bid.load_id]
      );

      await client.query("COMMIT");
      return sendSuccess(res, 200, { ok: true, bookingId }, "Accepted");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore
      }
      return sendError(res, 500, err.message || "Server error");
    } finally {
      client.release();
    }
  }
);

module.exports = router;
