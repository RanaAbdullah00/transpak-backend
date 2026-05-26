const express = require("express");
const { body } = require("express-validator");
const { protect, requireAnyRole, requireRole } = require("../middleware/authMiddleware");
const { sendSuccess, sendError } = require("../utils/apiResponse");
const { normalizeShipmentStatus, validateShipmentTransition } = require("../utils/shipmentStatus");
const {
  shipmentIdParam,
  shipmentStatusPutValidators,
  handleValidationErrors
} = require("../middleware/validateShipmentBody");
const { query } = require("../db/pool");
const { notifyUser } = require("../utils/notifyEvent");
const { emitToTracking } = require("../services/realtimeHub");
const {
  buildRouteCoordinates,
  trackRoomKey,
  trackingRefKey,
  buildTrackingUpdatePayload
} = require("../utils/trackingPayload");
const {
  validateGpsCoordinates,
  checkGpsThrottle,
  markGpsWritten,
  assertAssignedCarrierForGps
} = require("../utils/gpsTracking");
const { shipmentsRouteLimiter } = require("../middleware/apiRateLimit");
const { appendShipmentLocationLog } = require("../utils/shipmentLocationLog");
const { writeAudit } = require("../utils/auditLog");
const { hasAdminRole } = require("../utils/resourceAuth");

const router = express.Router();
router.use(shipmentsRouteLimiter);

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  );
}

function validLatLng(pair) {
  return (
    Array.isArray(pair) &&
    pair.length >= 2 &&
    Number.isFinite(Number(pair[0])) &&
    Number.isFinite(Number(pair[1]))
  );
}

function attachLocationFields(req, tracking) {
  const devSimFail =
    process.env.NODE_ENV !== "production" && String(req.query.simulateGpsFailure || "") === "1";
  const coords = tracking?.currentLocation;
  const hasValid = validLatLng(coords);
  const locationUnavailable = Boolean(tracking?.locationUnavailable) || devSimFail || !hasValid;
  const location = locationUnavailable ? null : [Number(coords[0]), Number(coords[1])];
  return {
    ...tracking,
    status: normalizeShipmentStatus(tracking?.status) || "posted",
    location,
    locationUnavailable,
    currentLocation: location
  };
}

function toTrackResponse(req, doc) {
  const raw = doc || {};
  const tracking = attachLocationFields(req, raw.tracking || {});
  return { ...raw, tracking };
}

function assertTrackAccessOrThrow(load, auth) {
  if (hasAdminRole(auth)) return;

  const uid = String(auth?.userId || "");
  const isShipper = String(load?.shipper_id || "") === uid;
  const isAssignedCarrier = String(load?.assigned_carrier_id || "") === uid;
  if (isShipper || isAssignedCarrier) return;
  throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
}

async function resolveLoadForRef(refKey) {
  const key = String(refKey || "").trim();
  if (!key) return null;
  if (isUuid(key)) {
    const { rows } = await query(
      `SELECT id, code, shipper_id, assigned_carrier_id, booking_reference
       FROM loads
       WHERE id = $1`,
      [key]
    );
    if (rows[0]) return rows[0];
  }
  const { rows } = await query(
    `SELECT id, code, shipper_id, assigned_carrier_id, booking_reference
     FROM loads
     WHERE code = $1`,
    [key]
  );
  return rows[0] || null;
}

async function getOrCreateShipment(loadId) {
  const { rows } = await query(
    `INSERT INTO shipments (load_id, status, location_unavailable)
     VALUES ($1, 'posted', true)
     ON CONFLICT (load_id)
     DO UPDATE SET load_id = EXCLUDED.load_id
     RETURNING id, load_id, status, current_lat, current_lng, location_unavailable, updated_at`,
    [loadId]
  );
  return rows[0];
}

async function getShipmentHistory(shipmentId) {
  const { rows } = await query(
    `SELECT status, note, location_label, created_at
     FROM shipment_events
     WHERE shipment_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [shipmentId]
  );
  return rows.map((r) => ({
    event: `Status: ${r.status}`,
    time: new Date(r.created_at).toLocaleString(),
    location: r.location_label || r.note || "System"
  }));
}

router.get(
  "/completed",
  protect,
  requireAnyRole(["shipper", "carrier", "admin"]),
  async (req, res) => {
    try {
      const uid = req.auth.userId;
      const { rows } = await query(
        `SELECT l.id, l.code, l.cargo, l.origin, l.destination,
                l.vehicle_type AS "vehicleType", l.pickup_date AS "pickupDate",
                s.status AS "shipmentStatus", s.updated_at AS "completedAt"
         FROM shipments s
         JOIN loads l ON l.id = s.load_id
         WHERE s.status IN ('delivered', 'closed')
           AND (l.shipper_id = $1 OR l.assigned_carrier_id = $1)
         ORDER BY s.updated_at DESC
         LIMIT 100`,
        [uid]
      );
      return sendSuccess(res, 200, rows);
    } catch (err) {
      return sendError(res, 500, err.message || "Server error");
    }
  }
);

router.get(
  "/track/:id",
  protect,
  requireAnyRole(["shipper", "carrier", "admin"]),
  shipmentIdParam,
  handleValidationErrors,
  async (req, res) => {
    try {
      const load = await resolveLoadForRef(req.params.id);
      if (!load) return sendError(res, 404, "Not found");
      assertTrackAccessOrThrow(load, req.auth);

      const { rows: loadRows } = await query(
        `SELECT origin, destination FROM loads WHERE id = $1`,
        [load.id]
      );
      const origin = loadRows[0]?.origin || "";
      const destination = loadRows[0]?.destination || "";
      const routeCoords = buildRouteCoordinates(origin, destination);

      const shipment = await getOrCreateShipment(load.id);
      const history = await getShipmentHistory(shipment.id);
      const core = await buildTrackingUpdatePayload(load.id, null, null);
      const payload = toTrackResponse(req, {
        ...core,
        refKey: trackingRefKey(load),
        history,
        liveTrackingMap: core?.liveTrackingMap || { coordinates: routeCoords }
      });
      return sendSuccess(res, 200, payload);
    } catch (err) {
      const status = err.statusCode || 500;
      const safeMsg =
        status >= 500 ? "Server error" : err.message || "Request failed";
      return sendError(res, status, safeMsg);
    }
  }
);

router.put(
  "/:id/status",
  protect,
  requireRole("carrier"),
  shipmentIdParam,
  shipmentStatusPutValidators,
  handleValidationErrors,
  async (req, res) => {
    try {
      const load = await resolveLoadForRef(req.params.id);
      if (!load) return sendError(res, 404, "Not found");
      assertTrackAccessOrThrow(load, req.auth);

      const { status } = req.body || {};
      const nextRaw = String(status || "").trim();

      const shipment = await getOrCreateShipment(load.id);
      const current = shipment.status;
      const check = validateShipmentTransition(current, nextRaw);
      if (!check.ok) return sendError(res, 400, check.message);

      const canonical = check.canonical;
      if (check.same) {
        const history = await getShipmentHistory(shipment.id);
        return sendSuccess(
          res,
          200,
          toTrackResponse(req, {
            refKey: trackRoomKey(load),
            tracking: { status: canonical, locationUnavailable: Boolean(shipment.location_unavailable) },
            history,
            liveTrackingMap: { coordinates: [] }
          })
        );
      }

      await query(
        `UPDATE shipments
         SET status = $2, updated_at = now()
         WHERE load_id = $1`,
        [load.id, canonical]
      );
      await query(
        `INSERT INTO shipment_events (shipment_id, status, note, location_label)
         VALUES ($1, $2, $3, $4)`,
        [shipment.id, canonical, null, "System"]
      );

      // Keep loads.status loosely in sync for list screens.
      const nextLoadStatus = canonical === "booked" ? "booked" : canonical === "closed" ? "closed" : load.status;
      if (nextLoadStatus && nextLoadStatus !== load.status) {
        await query(`UPDATE loads SET status = $2, updated_at = now() WHERE id = $1`, [load.id, nextLoadStatus]);
      }

      if (canonical === "delivered" || canonical === "closed") {
        const { rows: parties } = await query(
          `SELECT shipper_id, assigned_carrier_id FROM loads WHERE id = $1`,
          [load.id]
        );
        const p = parties[0];
        const ref = load.code || String(load.id).slice(0, 8);
        const msg = `Shipment ${ref} marked ${canonical}`;
        if (p?.shipper_id) {
          await notifyUser({
            receiverId: p.shipper_id,
            senderId: req.auth.userId,
            roleType: "carrier",
            title: "DELIVERY_COMPLETED",
            type: "DELIVERY_COMPLETED",
            message: msg
          });
        }
        if (p?.assigned_carrier_id) {
          await notifyUser({
            receiverId: p.assigned_carrier_id,
            senderId: req.auth.userId,
            roleType: "shipper",
            title: "DELIVERY_COMPLETED",
            type: "DELIVERY_COMPLETED",
            message: msg
          });
        }
      }

      const history = await getShipmentHistory(shipment.id);
      const core = await buildTrackingUpdatePayload(load.id, null, null);
      const payload = toTrackResponse(req, {
        ...core,
        refKey: trackingRefKey(load),
        history
      });
      const room = trackRoomKey(load);
      if (room && core) emitToTracking(room, "tracking:update", core);
      if (canonical === "booked") {
        void writeAudit({
          actorUserId: req.auth.userId,
          action: "shipment.started",
          targetEntity: "shipment",
          targetId: shipment.id,
          metadata: { loadId: load.id, status: canonical }
        });
      }
      if (canonical === "delivered" || canonical === "closed") {
        void writeAudit({
          actorUserId: req.auth.userId,
          action: "shipment.completed",
          targetEntity: "shipment",
          targetId: shipment.id,
          metadata: { loadId: load.id, status: canonical }
        });
      }
      return sendSuccess(res, 200, payload);
    } catch (err) {
      const status = err.statusCode || 500;
      const safeMsg =
        status >= 500 ? "Server error" : err.message || "Request failed";
      return sendError(res, status, safeMsg);
    }
  }
);

router.put(
  "/:id/location",
  protect,
  requireRole("carrier"),
  shipmentIdParam,
  [
    body("lat").isFloat({ min: -90, max: 90 }).withMessage("Invalid lat"),
    body("lng").isFloat({ min: -180, max: 180 }).withMessage("Invalid lng")
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const load = await resolveLoadForRef(req.params.id);
      if (!load) return sendError(res, 404, "Not found");
      assertTrackAccessOrThrow(load, req.auth);

      const carrierErr = assertAssignedCarrierForGps(load, req.auth.userId);
      if (carrierErr) throw carrierErr;

      const coordCheck = validateGpsCoordinates(req.body.lat, req.body.lng);
      if (!coordCheck.ok) return sendError(res, 400, coordCheck.message);

      const throttle = checkGpsThrottle(load.id);
      if (!throttle.ok) {
        return sendError(res, 429, throttle.message, { retryAfterMs: throttle.retryAfterMs });
      }

      const lat = coordCheck.lat;
      const lng = coordCheck.lng;
      const shipment = await getOrCreateShipment(load.id);

      const updateResult = await query(
        `UPDATE shipments
         SET current_lat = $2, current_lng = $3, location_unavailable = false, updated_at = now()
         WHERE load_id = $1`,
        [load.id, lat, lng]
      );
      if (!updateResult.rowCount) {
        return sendError(res, 500, "Could not save location");
      }
      markGpsWritten(load.id);
      await appendShipmentLocationLog(load.id, lat, lng);

      const history = await getShipmentHistory(shipment.id);
      const core = await buildTrackingUpdatePayload(load.id, lat, lng);
      const payload = toTrackResponse(req, {
        ...core,
        refKey: trackingRefKey(load),
        history
      });

      const room = trackRoomKey(load);
      if (room && core) {
        emitToTracking(room, "tracking:update", core);
      }
      return sendSuccess(res, 200, payload);
    } catch (err) {
      const status = err.statusCode || 500;
      return sendError(res, status, status >= 500 ? "Server error" : err.message || "Request failed");
    }
  }
);

module.exports = router;
