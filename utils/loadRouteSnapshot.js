const { query } = require("../db/pool");
const ors = require("../services/openRouteService");
const { normalizeRoutePayload } = require("./routeResponse");

/**
 * Resolve route via ORS proxy and persist on load (non-blocking failures).
 */
async function persistLoadRouteSnapshot(loadId, origin, destination) {
  const id = String(loadId || "");
  if (!id) return null;

  const result = await ors.routeBetweenCities(origin, destination);
  if (!result.ok) return null;

  const normalized = normalizeRoutePayload(result);
  if (normalized.coordinates.length < 2) return null;

  try {
    await query(
      `UPDATE loads
          SET route_coordinates = $2::jsonb,
              route_distance_km = $3,
              route_source = $4,
              updated_at = now()
        WHERE id = $1`,
      [
        id,
        JSON.stringify(normalized.coordinates),
        normalized.distanceKm,
        normalized.source
      ]
    );
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn("[loadRoute] persist failed:", err?.message || err);
    }
    return normalized;
  }

  return normalized;
}

async function getLoadRouteCoordinates(loadId) {
  const { rows } = await query(
    `SELECT origin, destination, route_coordinates FROM loads WHERE id = $1`,
    [loadId]
  );
  const row = rows[0];
  if (!row) return [];

  const stored = row.route_coordinates;
  if (Array.isArray(stored) && stored.length >= 2) {
    return normalizeRoutePayload({ coordinates: stored, source: "snapshot" }).coordinates;
  }
  if (stored && typeof stored === "object") {
    try {
      const parsed = typeof stored === "string" ? JSON.parse(stored) : stored;
      if (Array.isArray(parsed) && parsed.length >= 2) {
        return normalizeRoutePayload({ coordinates: parsed, source: "snapshot" }).coordinates;
      }
    } catch {
      /* ignore */
    }
  }

  const { buildRouteCoordinates } = require("./trackingPayload");
  return buildRouteCoordinates(row.origin, row.destination);
}

module.exports = { persistLoadRouteSnapshot, getLoadRouteCoordinates };
