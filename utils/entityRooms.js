/** Canonical socket room keys for logistics entities (no role split). */
function entityRoom(kind, id) {
  const k = String(kind || "").trim().toLowerCase();
  const i = String(id || "").trim();
  if (!k || !i) return null;
  if (!["shipment", "space", "bid", "track"].includes(k)) return null;
  return `${k}:${i}`;
}

function shipmentRoom(shipmentId) {
  return entityRoom("shipment", shipmentId);
}

function spaceRoom(requestId) {
  return entityRoom("space", requestId);
}

function bidRoom(bidId) {
  return entityRoom("bid", bidId);
}

function trackRoom(refKey) {
  return entityRoom("track", refKey);
}

module.exports = {
  entityRoom,
  shipmentRoom,
  spaceRoom,
  bidRoom,
  trackRoom
};
