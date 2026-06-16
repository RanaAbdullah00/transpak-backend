const { query } = require("../db/pool");
const { findCity, distanceBetweenCities } = require("./geoDistance");
const { normalizeShipmentStatus } = require("./shipmentStatus");
const { computeLifecycleStage } = require("./logisticsLifecycle");

function buildRouteCoordinates(origin, destination) {
  const coords = [];
  const o = findCity(origin);
  const d = findCity(destination);
  if (o) coords.push([o.lat, o.lng]);
  if (d && (!o || o.lat !== d.lat || o.lng !== d.lng)) coords.push([d.lat, d.lng]);
  return coords;
}

/** Socket room key — always load.code (never UUID). */
function trackRoomKey(load) {
  if (!load) return "";
  return String(load.code || "").trim();
}

/** API / client ref for URLs (code preferred, UUID fallback for lookup only). */
function trackingRefKey(load) {
  const code = trackRoomKey(load);
  return code || String(load?.id || "").trim();
}

async function buildTrackingUpdatePayload(loadId, lat, lng, extra = {}) {
  const { rows: loadRows } = await query(
    `SELECT l.id, l.code, l.origin, l.destination, l.status, l.shipper_id, l.assigned_carrier_id, l.pickup_date,
            COALESCE(uc.full_name, uc.email, 'Carrier') AS carrier_name,
            uc.phone AS carrier_phone,
            t.license_plate AS truck_plate,
            t.truck_type AS truck_vehicle_type
     FROM loads l
     LEFT JOIN users uc ON uc.id = l.assigned_carrier_id
     LEFT JOIN trucks t ON t.user_id = l.assigned_carrier_id AND t.is_default = true AND t.status = 'approved'
     WHERE l.id = $1`,
    [loadId]
  );
  const load = loadRows[0];
  if (!load) return null;

  const { rows: shipRows } = await query(
    `SELECT status, current_lat, current_lng, location_unavailable, updated_at
     FROM shipments WHERE load_id = $1`,
    [loadId]
  );
  const shipment = shipRows[0] || {};

  const { rows: bidStats } = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('pending_shipper_confirmation','counter_offered','pending','suggested'))::int AS active,
       COUNT(*) FILTER (WHERE status = 'accepted')::int AS accepted
     FROM bids WHERE load_id = $1`,
    [loadId]
  );
  const stats = bidStats[0] || { active: 0, accepted: 0 };

  const hasDbCoords =
    shipment.current_lat != null &&
    shipment.current_lng != null &&
    Number.isFinite(Number(shipment.current_lat)) &&
    Number.isFinite(Number(shipment.current_lng));

  const currentLocation = hasDbCoords
    ? [Number(shipment.current_lat), Number(shipment.current_lng)]
    : Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))
      ? [Number(lat), Number(lng)]
      : null;

  const origin = load.origin || "";
  const destination = load.destination || "";
  const locationUpdatedAt = shipment.updated_at
    ? new Date(shipment.updated_at).toISOString()
    : null;

  let routeCoords = buildRouteCoordinates(origin, destination);
  try {
    const { getLoadRouteCoordinates } = require("./loadRouteSnapshot");
    routeCoords = await getLoadRouteCoordinates(loadId);
  } catch {
    /* column may be missing before migration 016 */
  }

  const { ts: _dropTs, ...safeExtra } = extra || {};
  const distanceKm = distanceBetweenCities(origin, destination);
  const travelHours =
    distanceKm != null && distanceKm > 0 ? Math.max(0.5, Math.round((distanceKm / 65) * 10) / 10) : null;
  const eta =
    travelHours != null
      ? new Date(Date.now() + travelHours * 3600 * 1000).toISOString()
      : load.pickup_date
        ? new Date(`${String(load.pickup_date).slice(0, 10)}T12:00:00.000Z`).toISOString()
        : null;
  return {
    loadId: String(load.id),
    refKey: trackingRefKey(load),
    origin,
    destination,
    distanceKm: distanceKm != null && distanceKm > 0 ? distanceKm : null,
    shipperId: load.shipper_id ? String(load.shipper_id) : null,
    carrierId: load.assigned_carrier_id ? String(load.assigned_carrier_id) : null,
    carrierName: load.carrier_name || null,
    carrierPhone: load.carrier_phone || null,
    vehicleReg: load.truck_plate || null,
    vehicleType: load.truck_vehicle_type || null,
    lifecycleStage: computeLifecycleStage({
      loadStatus: load.status,
      shipmentStatus: shipment.status,
      activeBidCount: stats.active,
      acceptedBidCount: stats.accepted,
      assignedCarrierId: load.assigned_carrier_id
    }),
    tracking: {
      status: normalizeShipmentStatus(shipment.status) || "posted",
      currentLocation,
      locationUnavailable: !currentLocation,
      locationUpdatedAt,
      eta,
      driverName: load.carrier_name || null,
      vehicleReg: load.truck_plate || null,
      vehicleType: load.truck_vehicle_type || null
    },
    liveTrackingMap: { coordinates: routeCoords },
    ...safeExtra,
    ts: Date.now()
  };
}

module.exports = {
  buildRouteCoordinates,
  trackRoomKey,
  trackingRefKey,
  buildTrackingUpdatePayload
};
