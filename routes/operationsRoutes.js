const express = require("express");
const { protect } = require("../middleware/authMiddleware");
const { sendSuccess, sendError } = require("../utils/apiResponse");
const { query } = require("../db/pool");

const router = express.Router();

router.get("/snapshot", protect, async (req, res) => {
  try {
    const uid = req.auth.userId;
    const roles = req.auth?.roles || [];
    const active = req.auth?.activeRole;
    const out = { role: active, shipper: null, carrier: null };

    if (roles.includes("shipper") && (active === "shipper" || !active)) {
      const [{ rows: loads }, { rows: bids }, { rows: shipments }] = await Promise.all([
        query(
          `SELECT COUNT(*) FILTER (WHERE status = 'open')::int AS open,
                  COUNT(*) FILTER (WHERE status = 'booked')::int AS active
           FROM loads WHERE shipper_id = $1`,
          [uid]
        ),
        query(
          `SELECT COUNT(*)::int AS pending FROM bids b
           JOIN loads l ON l.id = b.load_id
           WHERE l.shipper_id = $1 AND b.status IN ('pending','suggested')`,
          [uid]
        ),
        query(
          `SELECT COUNT(*)::int AS completed FROM shipments s
           JOIN loads l ON l.id = s.load_id
           WHERE l.shipper_id = $1 AND s.status IN ('delivered','closed')`,
          [uid]
        )
      ]);
      out.shipper = {
        openLoads: loads[0]?.open ?? 0,
        activeShipments: loads[0]?.active ?? 0,
        pendingBids: bids[0]?.pending ?? 0,
        completedDeliveries: shipments[0]?.completed ?? 0
      };
    }

    if (roles.includes("carrier") && active === "carrier") {
      const [{ rows: bids }, { rows: space }, { rows: requests }] = await Promise.all([
        query(
          `SELECT COUNT(*) FILTER (WHERE status IN ('pending','suggested'))::int AS active,
                  COUNT(*) FILTER (WHERE status = 'accepted')::int AS won
           FROM bids WHERE carrier_id = $1`,
          [uid]
        ),
        query(
          `SELECT COUNT(*)::int AS listings,
                  COALESCE(SUM(remaining_space_kg),0)::numeric AS "remainingKg"
           FROM carrier_space_listings WHERE carrier_id = $1 AND status IN ('open','booked')`,
          [uid]
        ),
        query(
          `SELECT COUNT(*)::int AS pending FROM carrier_space_requests r
           JOIN carrier_space_listings l ON l.id = r.listing_id
           WHERE l.carrier_id = $1 AND r.status = 'request_sent'`,
          [uid]
        )
      ]);
      out.carrier = {
        activeBids: bids[0]?.active ?? 0,
        wonBids: bids[0]?.won ?? 0,
        spaceListings: space[0]?.listings ?? 0,
        remainingCapacityKg: Number(space[0]?.remainingKg ?? 0),
        pendingSpaceRequests: requests[0]?.pending ?? 0
      };
    }

    return sendSuccess(res, 200, out);
  } catch (err) {
    return sendError(res, 500, err.message || "Server error");
  }
});

module.exports = router;
