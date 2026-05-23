const { normalizeShipmentStatus } = require("./shipmentStatus");

/** Display lifecycle (Uber Freight style) — mapped onto existing DB enums. */
const STAGES = [
  "created",
  "posted",
  "bid_open",
  "bid_accepted",
  "assigned",
  "in_transit",
  "delivered",
  "closed"
];

function computeLifecycleStage({
  loadStatus,
  shipmentStatus,
  activeBidCount = 0,
  acceptedBidCount = 0,
  assignedCarrierId = null
}) {
  const load = String(loadStatus || "").toLowerCase();
  const ship = normalizeShipmentStatus(shipmentStatus) || "posted";

  if (load === "closed" || ship === "closed") return "closed";
  if (ship === "delivered") return "delivered";
  if (ship === "intransit" || ship === "pickedup") return "in_transit";
  if (load === "booked" || ship === "booked" || assignedCarrierId) return "assigned";
  if (acceptedBidCount > 0) return "bid_accepted";
  if (activeBidCount > 0) return "bid_open";
  if (load === "open") return "posted";
  return "created";
}

module.exports = { STAGES, computeLifecycleStage };
