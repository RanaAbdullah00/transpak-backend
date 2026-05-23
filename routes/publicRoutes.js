const express = require("express");
const { sendSuccess, sendError } = require("../utils/apiResponse");
const { query } = require("../db/pool");
const { asyncHandler } = require("../utils/asyncHandler");

const router = express.Router();

/** Public freight snapshot for landing page (no auth). */
router.get(
  "/stats",
  asyncHandler(async (req, res) => {
    try {
      const [openLoads, activeShipments, bidsToday, carriersActive] = await Promise.all([
        query(`SELECT COUNT(*)::int AS c FROM loads WHERE status = 'open'`),
        query(
          `SELECT COUNT(*)::int AS c FROM shipments WHERE status IN ('booked','pickedup','intransit')`
        ),
        query(
          `SELECT COUNT(*)::int AS c FROM bids WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')`
        ),
        query(
          `SELECT COUNT(DISTINCT carrier_id)::int AS c FROM bids WHERE created_at >= now() - interval '7 days'`
        )
      ]);
      return sendSuccess(res, 200, {
        openLoads: openLoads.rows[0].c,
        activeShipments: activeShipments.rows[0].c,
        bidsToday: bidsToday.rows[0].c,
        carriersActive: carriersActive.rows[0].c
      });
    } catch (err) {
      return sendError(res, 500, err.message || "Server error");
    }
  })
);

module.exports = router;
