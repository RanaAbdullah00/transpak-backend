const { query } = require("../db/pool");

async function appendShipmentLocationLog(loadId, lat, lng) {
  const la = Number(lat);
  const ln = Number(lng);
  if (!loadId || !Number.isFinite(la) || !Number.isFinite(ln)) return;
  try {
    await query(
      `INSERT INTO shipment_location_log (load_id, lat, lng, recorded_at)
       VALUES ($1, $2, $3, now())`,
      [loadId, la, ln]
    );
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn("[gps-log] insert failed:", err?.message || err);
    }
  }
}

async function getRecentLocationTrail(loadId, limit = 30) {
  const { rows } = await query(
    `SELECT lat, lng, recorded_at
       FROM shipment_location_log
      WHERE load_id = $1
      ORDER BY recorded_at ASC
      LIMIT $2`,
    [loadId, Math.min(Math.max(Number(limit) || 30, 5), 100)]
  );
  return rows.map((r) => [Number(r.lat), Number(r.lng)]);
}

module.exports = { appendShipmentLocationLog, getRecentLocationTrail };
