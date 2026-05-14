/** Canonical shipment lifecycle: strict linear forward only (no skip, no backward). */
const SHIPMENT_ORDER = ["posted", "booked", "pickedup", "intransit", "delivered", "closed"];

/** Explicit allowed next state per current state (mirrors sequential rule). */
const ALLOWED_TRANSITIONS = {
  posted: ["booked"],
  booked: ["pickedup"],
  pickedup: ["intransit"],
  intransit: ["delivered"],
  delivered: ["closed"],
  closed: []
};

const LEGACY_TO_CANON = {
  posted: "posted",
  booked: "booked",
  pickedup: "pickedup",
  picked: "pickedup",
  intransit: "intransit",
  delivered: "delivered",
  closed: "closed",
  pending: "posted",
  open: "posted"
};

function normalizeShipmentStatus(raw) {
  const key = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  const mapped = LEGACY_TO_CANON[key];
  if (mapped) return mapped;
  if (SHIPMENT_ORDER.includes(key)) return key;
  return null;
}

function validateShipmentTransition(currentRaw, nextRaw) {
  const current = normalizeShipmentStatus(currentRaw) || "posted";
  const next = normalizeShipmentStatus(nextRaw);
  if (!next) return { ok: false, message: "Invalid status" };

  if (next === current) return { ok: true, same: true, canonical: next };

  const allowed = ALLOWED_TRANSITIONS[current];
  if (!allowed || !allowed.includes(next)) {
    return {
      ok: false,
      message: "Invalid status transition: only sequential forward moves are allowed"
    };
  }

  return { ok: true, same: false, canonical: next };
}

module.exports = {
  SHIPMENT_ORDER,
  ALLOWED_TRANSITIONS,
  normalizeShipmentStatus,
  validateShipmentTransition
};
