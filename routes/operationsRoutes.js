const express = require("express");
const { protect, requireAnyRole, validateViewAs } = require("../middleware/authMiddleware");
const { resolveCommercialViewRole } = require("../utils/commercialViewRole");
const { sendSuccess, sendError } = require("../utils/apiResponse");
const { query } = require("../db/pool");
const { buildEventSync } = require("../utils/eventSync");

const router = express.Router();

const SHIPMENT_PARTY_SQL = `(l.shipper_id = $1 OR l.assigned_carrier_id = $1)`;

async function shipmentOpsCounts(uid) {
  const { rows: activeRows } = await query(
    `SELECT
       COUNT(*) FILTER (WHERE s.status IN ('booked', 'pickedup'))::int AS active,
       COUNT(*) FILTER (WHERE s.status = 'intransit')::int AS "inTransit"
     FROM shipments s
     JOIN loads l ON l.id = s.load_id
     WHERE ${SHIPMENT_PARTY_SQL}
       AND s.status NOT IN ('delivered', 'closed')`,
    [uid]
  );
  const { rows: completedRows } = await query(
    `SELECT COUNT(*)::int AS completed
     FROM shipments s
     JOIN loads l ON l.id = s.load_id
     WHERE ${SHIPMENT_PARTY_SQL}
       AND s.status IN ('delivered', 'closed')`,
    [uid]
  );
  return {
    activeShipmentCount: activeRows[0]?.active ?? 0,
    inTransitShipmentCount: activeRows[0]?.inTransit ?? 0,
    completedShipmentCount: completedRows[0]?.completed ?? 0
  };
}

/** Reconnect recovery — backend-confirmed events since timestamp. */
router.get(
  "/sync/events",
  protect,
  requireAnyRole(["shipper", "carrier", "admin"]),
  async (req, res) => {
    try {
      const payload = await buildEventSync(req.auth, req);
      return sendSuccess(res, 200, payload);
    } catch (err) {
      return sendError(res, 500, err.message || "Server error");
    }
  }
);

router.get(
  "/snapshot",
  protect,
  requireAnyRole(["shipper", "carrier", "admin"]),
  validateViewAs(),
  async (req, res) => {
    try {
      const uid = req.auth.userId;
      const roles = req.auth?.roles || [];
      const viewAs = resolveCommercialViewRole(roles, req.commercialView);
      const out = { shipper: null, carrier: null };

      const includeShipper = viewAs ? viewAs === "shipper" : roles.includes("shipper");
      const includeCarrier = viewAs ? viewAs === "carrier" : roles.includes("carrier");

      if (includeShipper) {
        const [
          { rows: loads },
          { rows: bids },
          { rows: sentRequests },
          shipmentCounts
        ] = await Promise.all([
          query(
            `SELECT COUNT(*) FILTER (WHERE status = 'open')::int AS open,
                    COUNT(*) FILTER (WHERE status = 'booked')::int AS booked
             FROM loads WHERE shipper_id = $1`,
            [uid]
          ),
          query(
            `SELECT COUNT(*)::int AS pending FROM bids b
             JOIN loads l ON l.id = b.load_id
             WHERE l.shipper_id = $1 AND b.status IN ('pending_shipper_confirmation','counter_offered','pending','suggested')`,
            [uid]
          ),
          query(
            `SELECT COUNT(*)::int AS pending FROM carrier_space_requests r
             WHERE r.shipper_id = $1 AND r.status IN ('request_sent', 'accepted')`,
            [uid]
          ),
          shipmentOpsCounts(uid)
        ]);
        out.shipper = {
          openLoads: loads[0]?.open ?? 0,
          pendingBids: bids[0]?.pending ?? 0,
          requestSentCount: sentRequests[0]?.pending ?? 0,
          activeShipmentCount: shipmentCounts.activeShipmentCount,
          inTransitShipmentCount: shipmentCounts.inTransitShipmentCount,
          completedShipmentCount: shipmentCounts.completedShipmentCount,
          activeShipments: loads[0]?.booked ?? 0,
          completedDeliveries: shipmentCounts.completedShipmentCount
        };
      }

      if (includeCarrier) {
        const [
          { rows: bids },
          { rows: space },
          { rows: requests },
          shipmentCounts
        ] = await Promise.all([
          query(
            `SELECT COUNT(*) FILTER (WHERE status IN ('pending_shipper_confirmation','counter_offered','pending','suggested'))::int AS active,
                    COUNT(*) FILTER (WHERE status = 'accepted')::int AS won
             FROM bids WHERE carrier_id = $1 AND status <> 'cancelled'`,
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
             WHERE l.carrier_id = $1 AND r.status IN ('request_sent', 'accepted')`,
            [uid]
          ),
          shipmentOpsCounts(uid)
        ]);
        out.carrier = {
          activeBids: bids[0]?.active ?? 0,
          wonBids: bids[0]?.won ?? 0,
          spaceListings: space[0]?.listings ?? 0,
          remainingCapacityKg: Number(space[0]?.remainingKg ?? 0),
          requestSentCount: requests[0]?.pending ?? 0,
          activeShipmentCount: shipmentCounts.activeShipmentCount,
          inTransitShipmentCount: shipmentCounts.inTransitShipmentCount,
          completedShipmentCount: shipmentCounts.completedShipmentCount,
          pendingSpaceRequests: requests[0]?.pending ?? 0,
          activeShipments: shipmentCounts.activeShipmentCount,
          completedDeliveries: shipmentCounts.completedShipmentCount
        };
      }

      return sendSuccess(res, 200, out);
    } catch (err) {
      return sendError(res, 500, err.message || "Server error");
    }
  }
);

module.exports = router;
