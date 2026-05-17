const express = require("express");
const { body, param, validationResult } = require("express-validator");
const { protect, requireAnyRole, requireActiveRole } = require("../middleware/authMiddleware");
const { sendSuccess, sendError } = require("../utils/apiResponse");
const { query } = require("../db/pool");
const userRepo = require("../repositories/userRepo");
const loadController = require("../src/controllers/loadController");
const { estimateDistanceKm, calculateSuggestedFare } = require("../utils/loadFare");
const { apiLoadStatus } = require("../utils/bidStateMachine");

const router = express.Router();

function isISODateOnly(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());
}

function startOfTodayUTC() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function generateCode() {
  return `L-${Math.floor(100000 + Math.random() * 900000)}`;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  );
}

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendError(res, 400, errors.array()[0]?.msg || "Validation error", {
      fields: errors.array().map((e) => e.path)
    });
  }
  return next();
}

router.get("/", protect, requireAnyRole(["carrier", "admin"]), requireActiveRole("carrier"), loadController.listOpen);

router.get("/mine", protect, requireAnyRole(["shipper", "admin"]), requireActiveRole("shipper"), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT l.id, l.code, l.cargo, l.origin, l.destination, l.weight, l.vehicle_type AS "vehicleType",
              l.expected_price AS "expectedPrice", l.pickup_date AS "pickupDate", l.deadline_hours AS "deadlineHours",
              l.status, l.shipper_id AS "shipperId", l.assigned_carrier_id AS "assignedCarrierId",
              l.accepted_bid_id AS "acceptedBidId", l.booking_reference AS "bookingReference",
              l.created_at AS "createdAt", l.updated_at AS "updatedAt",
              (SELECT COUNT(*)::int FROM bids b WHERE b.load_id = l.id AND b.status IN ('pending','suggested')) AS "bidCount"
       FROM loads l
       WHERE l.shipper_id = $1
       ORDER BY l.created_at DESC
       LIMIT 200`,
      [req.auth.userId]
    );
    return sendSuccess(res, 200, rows);
  } catch (err) {
    return sendError(res, 500, err.message || "Server error");
  }
});

const updateLoadValidators = [
  param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid load id"); })())),
  body("cargo").optional().trim().isLength({ min: 2, max: 200 }).withMessage("cargo must be 2-200 chars"),
  body("origin").optional().trim().isLength({ min: 2, max: 120 }).withMessage("origin must be 2-120 chars"),
  body("destination").optional().trim().isLength({ min: 2, max: 120 }).withMessage("destination must be 2-120 chars"),
  body("weight").optional({ nullable: true }).toFloat().isFloat({ min: 0 }).withMessage("weight must be a non-negative number"),
  body("vehicleType")
    .optional({ nullable: true })
    .trim()
    .isLength({ min: 2, max: 80 })
    .withMessage("vehicleType must be 2-80 chars"),
  body("expectedPrice")
    .optional({ nullable: true })
    .toFloat()
    .isFloat({ min: 0 })
    .withMessage("expectedPrice must be non-negative"),
  body("price")
    .optional({ nullable: true })
    .toFloat()
    .isFloat({ min: 0 })
    .withMessage("price must be non-negative"),
  body("pickupDate")
    .optional({ nullable: true })
    .trim()
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .withMessage("pickupDate must be YYYY-MM-DD"),
  body("deadlineHours")
    .optional({ nullable: true })
    .toInt()
    .isInt({ min: 1, max: 72 })
    .withMessage("deadlineHours must be 1-72")
];

async function updateLoad(req, res) {
  try {
    const { cargo, origin, destination, weight, type, vehicleType, price, expectedPrice, pickupDate, deadlineHours } =
      req.body || {};

    const { rows: found } = await query(
      `SELECT id, shipper_id, status, vehicle_type, expected_price
       FROM loads
       WHERE id = $1`,
      [req.params.id]
    );
    const load = found[0];
    if (!load) return sendError(res, 404, "Not found");
    if (String(load.shipper_id) !== String(req.auth.userId)) return sendError(res, 403, "Forbidden");
    if (load.status !== "open") return sendError(res, 409, "Only open loads can be updated");

    let nextPickupDate = null;
    if (pickupDate !== undefined && pickupDate !== null && String(pickupDate).trim() !== "") {
      const pickup = String(pickupDate).trim();
      if (!isISODateOnly(pickup)) return sendError(res, 400, "pickupDate must be YYYY-MM-DD");
      const today = startOfTodayUTC();
      const pickupDt = new Date(`${pickup}T00:00:00.000Z`);
      if (!(pickupDt.getTime() > today.getTime())) {
        return sendError(res, 400, "Pickup date must be in the future");
      }
      nextPickupDate = pickup;
    }

    const nextVehicle = vehicleType !== undefined || type !== undefined ? String(vehicleType || type || load.vehicle_type).trim() : load.vehicle_type;
    const nextExpected = expectedPrice !== undefined || price !== undefined ? Number(expectedPrice ?? price ?? load.expected_price) : Number(load.expected_price);

    const { rows } = await query(
      `UPDATE loads
       SET cargo = COALESCE($2, cargo),
           origin = COALESCE($3, origin),
           destination = COALESCE($4, destination),
           weight = COALESCE($5, weight),
           vehicle_type = $6,
           expected_price = $7,
           pickup_date = COALESCE($8::date, pickup_date),
           deadline_hours = COALESCE($9, deadline_hours),
           updated_at = now()
       WHERE id = $1
       RETURNING id, code, cargo, origin, destination, weight, vehicle_type AS "vehicleType",
                 expected_price AS "expectedPrice", pickup_date AS "pickupDate", deadline_hours AS "deadlineHours",
                 status, shipper_id AS "shipperId", assigned_carrier_id AS "assignedCarrierId",
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        req.params.id,
        cargo !== undefined ? String(cargo).trim() : null,
        origin !== undefined ? String(origin).trim() : null,
        destination !== undefined ? String(destination).trim() : null,
        weight !== undefined ? Number(weight) : null,
        nextVehicle,
        nextExpected,
        nextPickupDate,
        deadlineHours !== undefined && deadlineHours !== null && deadlineHours !== "" ? Number(deadlineHours) : null
      ]
    );
    return sendSuccess(res, 200, rows[0], "Updated");
  } catch (err) {
    return sendError(res, 500, err.message || "Server error");
  }
}

async function deleteOwnOpenLoad(req, res) {
  try {
    const { rows: found } = await query(`SELECT id, shipper_id, status FROM loads WHERE id = $1`, [req.params.id]);
    const load = found[0];
    if (!load) return sendError(res, 404, "Not found");
    if (String(load.shipper_id) !== String(req.auth.userId)) return sendError(res, 403, "Forbidden");
    if (load.status !== "open") return sendError(res, 409, "Only open loads can be deleted");

    await query(`DELETE FROM loads WHERE id = $1`, [req.params.id]);
    return sendSuccess(res, 200, { ok: true }, "Deleted");
  } catch (err) {
    return sendError(res, 500, err.message || "Server error");
  }
}

router.patch(
  "/:id",
  protect,
  requireAnyRole(["shipper", "admin"]),
  requireActiveRole("shipper"),
  updateLoadValidators,
  validate,
  updateLoad
);

router.delete(
  "/:id",
  protect,
  requireAnyRole(["shipper", "admin"]),
  requireActiveRole("shipper"),
  [param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid load id"); })()))],
  validate,
  deleteOwnOpenLoad
);

router.get("/:id", protect, async (req, res) => {
  const id = req.params.id;
  if (!isUuid(id)) return sendError(res, 400, "Invalid load id");
  const { rows } = await query(
    `SELECT id, code, cargo, origin, destination, weight, vehicle_type AS "vehicleType",
            expected_price AS "expectedPrice", pickup_date AS "pickupDate", deadline_hours AS "deadlineHours",
            status, shipper_id AS "shipperId", assigned_carrier_id AS "assignedCarrierId",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM loads
     WHERE id = $1`,
    [id]
  );
  const load = rows[0];
  if (!load) return sendError(res, 404, "Not found");

  const roles = req.auth?.roles || [];
  const isAdmin = roles.includes("admin");
  const isOwner = String(load.shipperId) === String(req.auth.userId);
  const isAssignedCarrier = load.assignedCarrierId && String(load.assignedCarrierId) === String(req.auth.userId);
  if (!isAdmin && !isOwner && !isAssignedCarrier) return sendError(res, 403, "Forbidden");
  return sendSuccess(res, 200, load);
});

async function createLoad(req, res) {
  const user = await userRepo.findById(req.auth.userId);
  if (!user) return sendError(res, 401, "Unauthorized");
  if (!user.isProfileComplete) {
    return sendError(res, 403, "Complete your profile to post loads");
  }
  const {
    cargo,
    origin,
    destination,
    weight,
    type,
    vehicleType,
    price,
    expectedPrice,
    pickupDate,
    deadlineHours,
    distanceKm
  } = req.body || {};

  const pickupLoc = String(origin || "").trim();
  const dropLoc = String(destination || "").trim();
  const distKm = estimateDistanceKm(pickupLoc, dropLoc, distanceKm);
  const vType = String(vehicleType || type || "Truck").trim();
  const suggestedFare = calculateSuggestedFare(distKm, vType);
  const resolvedPrice = Number(expectedPrice ?? price ?? suggestedFare ?? 0);

  const pickup = String(pickupDate || "").trim();
  if (!isISODateOnly(pickup)) return sendError(res, 400, "pickupDate must be YYYY-MM-DD");

  const today = startOfTodayUTC();
  const pickupDt = new Date(`${pickup}T00:00:00.000Z`);
  if (!(pickupDt.getTime() > today.getTime())) {
    return sendError(res, 400, "Pickup date must be in the future");
  }

  const code = generateCode();
  const { rows } = await query(
    `INSERT INTO loads
       (code, shipper_id, cargo, origin, destination, weight, vehicle_type, expected_price, pickup_date, deadline_hours, status,
        distance_km, suggested_fare, pickup_location, drop_location)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10, 'open', $11, $12, $13, $14)
     RETURNING id, code, cargo, origin, destination, weight, vehicle_type AS "vehicleType",
               expected_price AS "expectedPrice", pickup_date AS "pickupDate", deadline_hours AS "deadlineHours",
               status, shipper_id AS "shipperId", assigned_carrier_id AS "assignedCarrierId",
               distance_km AS "distanceKm", suggested_fare AS "suggestedFare",
               pickup_location AS "pickupLocation", drop_location AS "dropLocation",
               created_at AS "createdAt", updated_at AS "updatedAt"`,
    [
      code,
      req.auth.userId,
      String(cargo || "Load").trim(),
      pickupLoc,
      dropLoc,
      Number(weight || 0),
      vType,
      resolvedPrice,
      pickup,
      Number(deadlineHours || 2),
      distKm,
      suggestedFare,
      pickupLoc,
      dropLoc
    ]
  );
  const load = { ...rows[0], flowStatus: apiLoadStatus(rows[0].status) };
  // ensure shipment row exists for tracking lifecycle
  await query(
    `INSERT INTO shipments (load_id, status, location_unavailable)
     VALUES ($1, 'posted', true)
     ON CONFLICT (load_id) DO NOTHING`,
    [load.id]
  );
  return sendSuccess(res, 201, load, "Created");
}

const createLoadValidators = [
  body("cargo").trim().isLength({ min: 2, max: 200 }).withMessage("cargo must be 2-200 chars"),
  body("origin").trim().isLength({ min: 2, max: 120 }).withMessage("origin must be 2-120 chars"),
  body("destination").trim().isLength({ min: 2, max: 120 }).withMessage("destination must be 2-120 chars"),
  body("weight").toFloat().isFloat({ min: 0 }).withMessage("weight must be a non-negative number"),
  body("vehicleType")
    .optional()
    .trim()
    .isLength({ min: 2, max: 80 })
    .withMessage("vehicleType must be 2-80 chars"),
  body("expectedPrice")
    .optional({ nullable: true })
    .toFloat()
    .isFloat({ min: 0 })
    .withMessage("expectedPrice must be non-negative"),
  body("price")
    .optional({ nullable: true })
    .toFloat()
    .isFloat({ min: 0 })
    .withMessage("price must be non-negative"),
  body("pickupDate").trim().matches(/^\d{4}-\d{2}-\d{2}$/).withMessage("pickupDate must be YYYY-MM-DD"),
  body("deadlineHours")
    .optional({ nullable: true })
    .toInt()
    .isInt({ min: 1, max: 72 })
    .withMessage("deadlineHours must be 1-72"),
  body("distanceKm")
    .optional({ nullable: true })
    .toFloat()
    .isFloat({ min: 0 })
    .withMessage("distanceKm must be non-negative")
];

router.post("/", protect, requireAnyRole(["shipper", "admin"]), requireActiveRole("shipper"), createLoadValidators, validate, createLoad);
router.post("/create", protect, requireAnyRole(["shipper", "admin"]), requireActiveRole("shipper"), createLoadValidators, validate, createLoad);

module.exports = router;
