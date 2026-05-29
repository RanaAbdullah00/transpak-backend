/**
 * Express helpers that load a resource and enforce ownership before the handler runs.
 */
const { query } = require("../db/pool");
const { sendError } = require("../utils/apiResponse");
const {
  canReadLoad,
  canMutateLoadAsShipper,
  hasAccountRole,
  sendForbidden,
  FORBIDDEN_CODES
} = require("../utils/resourceAuth");
const { assertCarrierCanAccessLoad } = require("../utils/matchingEngine");

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  );
}

/** Attach req.loadRow after read authorization (GET /loads/:id). */
function requireLoadRead(paramName = "id") {
  return async (req, res, next) => {
    try {
      const id = String(req.params[paramName] || "");
      if (!isUuid(id)) return sendError(res, 400, "Invalid load id", null, "VALIDATION_ERROR");
      const { rows } = await query(
        `SELECT id, code, cargo, origin, destination, weight, vehicle_type, status,
                shipper_id, assigned_carrier_id, pickup_date,
                deadline_hours, deadline_minutes, created_at, updated_at
         FROM loads WHERE id = $1`,
        [id]
      );
      const load = rows[0];
      if (!load) return sendError(res, 404, "Not found", null, "NOT_FOUND");
      if (!canReadLoad(load, req.auth)) {
        return sendForbidden(res, "You do not have access to this load", FORBIDDEN_CODES.FORBIDDEN_RESOURCE);
      }
      if (
        hasAccountRole(req.auth, "carrier") &&
        String(load.assigned_carrier_id || "") !== String(req.auth.userId)
      ) {
        const match = await assertCarrierCanAccessLoad(req.auth.userId, load);
        if (!match.ok) {
          return sendError(res, match.status, match.message, null, match.code);
        }
      }
      req.loadRow = load;
      return next();
    } catch (err) {
      return sendError(res, 500, err.message || "Server error", null, "SERVER_ERROR");
    }
  };
}

/** Attach req.loadRow for shipper mutations (PATCH/DELETE open loads). */
function requireLoadShipperMutate(paramName = "id") {
  return async (req, res, next) => {
    try {
      const id = String(req.params[paramName] || "");
      if (!isUuid(id)) return sendError(res, 400, "Invalid load id", null, "VALIDATION_ERROR");
      const { rows } = await query(
        `SELECT id, shipper_id, status, vehicle_type, expected_price
         FROM loads WHERE id = $1`,
        [id]
      );
      const load = rows[0];
      if (!load) return sendError(res, 404, "Not found", null, "NOT_FOUND");
      if (!canMutateLoadAsShipper(load, req.auth)) {
        return sendForbidden(
          res,
          load.status !== "open" ? "Only open loads can be changed" : "Forbidden",
          FORBIDDEN_CODES.FORBIDDEN_OWNER
        );
      }
      req.loadRow = load;
      return next();
    } catch (err) {
      return sendError(res, 500, err.message || "Server error", null, "SERVER_ERROR");
    }
  };
}

module.exports = { requireLoadRead, requireLoadShipperMutate, isUuid };
