/** In-memory GPS rate limit per load (per server instance). */
const lastGpsAt = new Map();
const MIN_INTERVAL_MS = Number(process.env.GPS_UPDATE_MIN_INTERVAL_MS || 10000);

function validateGpsCoordinates(lat, lng) {
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) {
    return { ok: false, message: "Invalid coordinates" };
  }
  if (la < -90 || la > 90 || ln < -180 || ln > 180) {
    return { ok: false, message: "Coordinates out of range" };
  }
  return { ok: true, lat: la, lng: ln };
}

function checkGpsThrottle(loadId) {
  const key = String(loadId || "");
  if (!key) return { ok: false, message: "Invalid load" };
  const now = Date.now();
  const last = lastGpsAt.get(key) || 0;
  if (now - last < MIN_INTERVAL_MS) {
    return { ok: false, message: "GPS updates too frequent", retryAfterMs: MIN_INTERVAL_MS - (now - last) };
  }
  return { ok: true };
}

function markGpsWritten(loadId) {
  const key = String(loadId || "");
  if (key) lastGpsAt.set(key, Date.now());
}

function assertAssignedCarrierForGps(load, userId) {
  const uid = String(userId || "");
  const assigned = String(load?.assigned_carrier_id || "");
  if (!assigned) {
    const err = new Error("No carrier assigned to this load");
    err.statusCode = 403;
    return err;
  }
  if (assigned !== uid) {
    const err = new Error("Only the assigned carrier may update live location");
    err.statusCode = 403;
    return err;
  }
  return null;
}

module.exports = {
  validateGpsCoordinates,
  checkGpsThrottle,
  markGpsWritten,
  assertAssignedCarrierForGps,
  MIN_INTERVAL_MS
};
