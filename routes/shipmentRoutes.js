const express = require("express");
const { protect, requireAnyRole, requireActiveRole } = require("../middleware/authMiddleware");
const { sendSuccess, sendError } = require("../utils/apiResponse");
const { normalizeShipmentStatus, validateShipmentTransition } = require("../utils/shipmentStatus");
const {
  shipmentIdParam,
  shipmentStatusPutValidators,
  handleValidationErrors
} = require("../middleware/validateShipmentBody");
const { query } = require("../db/pool");

const router = express.Router();

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

function assertTrackAccessOrThrow(load, auth, { allowCarrierStatusWrite = false } = {}) {
  const roles = auth?.roles || [];
  const isAdmin = roles.includes("admin");
  if (isAdmin) return;

  const uid = String(auth?.userId || "");
  const isShipper = String(load?.shipper_id || "") === uid;
  const isAssignedCarrier = String(load?.assigned_carrier_id || "") === uid;
  if (isShipper) return;
  if (allowCarrierStatusWrite && isAssignedCarrier) return;
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
  "/track/:id",
  protect,
  requireAnyRole(["shipper", "carrier", "admin"]),
  shipmentIdParam,
  handleValidationErrors,
  async (req, res) => {
    try {
      const load = await resolveLoadForRef(req.params.id);
      if (!load) return sendError(res, 404, "Not found");
      assertTrackAccessOrThrow(load, req.auth, { allowCarrierStatusWrite: false });

      const shipment = await getOrCreateShipment(load.id);
      const history = await getShipmentHistory(shipment.id);
      const tracking = {
        status: normalizeShipmentStatus(shipment.status) || "posted",
        currentLocation:
          shipment.location_unavailable || shipment.current_lat == null || shipment.current_lng == null
            ? null
            : [Number(shipment.current_lat), Number(shipment.current_lng)],
        locationUnavailable: Boolean(shipment.location_unavailable)
      };
      const payload = toTrackResponse(req, {
        refKey: load.code || load.id,
        tracking,
        history,
        liveTrackingMap: { coordinates: [] }
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
  requireAnyRole(["carrier", "admin"]),
  requireActiveRole("carrier"),
  shipmentIdParam,
  shipmentStatusPutValidators,
  handleValidationErrors,
  async (req, res) => {
    try {
      const load = await resolveLoadForRef(req.params.id);
      if (!load) return sendError(res, 404, "Not found");
      assertTrackAccessOrThrow(load, req.auth, { allowCarrierStatusWrite: true });

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
            refKey: load.code || load.id,
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

      const history = await getShipmentHistory(shipment.id);
      const payload = toTrackResponse(req, {
        refKey: load.code || load.id,
        tracking: { status: canonical, locationUnavailable: Boolean(shipment.location_unavailable) },
        history,
        liveTrackingMap: { coordinates: [] }
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

module.exports = router;
