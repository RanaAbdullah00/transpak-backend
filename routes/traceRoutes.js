const express = require("express");
const { protect, requireAnyRole } = require("../middleware/authMiddleware");
const { sendSuccess, sendError } = require("../utils/apiResponse");
const { query } = require("../db/pool");
const { getTracesByShipment } = require("../utils/traceStore");

const router = express.Router();

async function assertShipmentAccess(shipmentId, auth) {
  const { rows } = await query(
    `SELECT s.id, l.shipper_id, l.assigned_carrier_id
     FROM shipments s
     JOIN loads l ON l.id = s.load_id
     WHERE s.id = $1`,
    [shipmentId]
  );
  const row = rows[0];
  if (!row) return { ok: false, status: 404 };
  const uid = String(auth.userId);
  const roles = (auth.roles || []).map((r) => String(r).toLowerCase());
  if (roles.includes("admin")) return { ok: true, row };
  if (String(row.shipper_id) === uid || String(row.assigned_carrier_id) === uid) {
    return { ok: true, row };
  }
  return { ok: false, status: 403 };
}

router.get(
  "/shipment/:id",
  protect,
  requireAnyRole(["shipper", "carrier", "admin"]),
  async (req, res) => {
    try {
      const shipmentId = String(req.params.id || "").trim();
      const access = await assertShipmentAccess(shipmentId, req.auth);
      if (!access.ok) return sendError(res, access.status, access.status === 404 ? "Not found" : "Forbidden");
      const data = await getTracesByShipment(shipmentId, { limit: req.query?.limit });
      return sendSuccess(res, 200, data);
    } catch (err) {
      return sendError(res, 500, err.message || "Server error");
    }
  }
);

router.get(
  "/:traceId",
  protect,
  requireAnyRole(["shipper", "carrier", "admin"]),
  async (req, res) => {
    try {
      const { getTraceById } = require("../utils/traceStore");
      const trace = await getTraceById(req.params.traceId);
      if (!trace.spans?.length) return sendError(res, 404, "Trace not found");
      return sendSuccess(res, 200, trace);
    } catch (err) {
      return sendError(res, 500, err.message || "Server error");
    }
  }
);

module.exports = router;
