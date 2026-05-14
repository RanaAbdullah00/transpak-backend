const { normalizeShipmentStatus } = require("./shipmentStatus");

/**
 * Map canonical ShipmentTrack status → Load.status enum.
 * Avoids demoting a booked load when track is still "posted" (stale track).
 */
function loadStatusFromCanonicalTrack(load, canonicalRaw) {
  const c = normalizeShipmentStatus(canonicalRaw);
  if (!c) return null;

  if (c === "posted") {
    return load.assignedCarrierId ? "assigned" : "open";
  }

  const map = {
    booked: "assigned",
    pickedup: "in_transit",
    intransit: "in_transit",
    delivered: "delivered",
    closed: "delivered"
  };
  return map[c] ?? null;
}

module.exports = { loadStatusFromCanonicalTrack };
