const express = require("express");
const { body, param, query, validationResult } = require("express-validator");
const { protect, requireAnyRole, requireRole } = require("../middleware/authMiddleware");
const { sendSuccess, sendError } = require("../utils/apiResponse");
const { query: dbQuery } = require("../db/pool");
const userRepo = require("../repositories/userRepo");
const { notifyUser } = require("../utils/notifyEvent");
const { hasAdminRole } = require("../utils/resourceAuth");

const router = express.Router();

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
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

router.get("/", protect, requireAnyRole(["shipper", "carrier", "admin"]), async (req, res) => {
  const origin = String(req.query?.origin || "").trim();
  const destination = String(req.query?.destination || "").trim();
  const vehicleType = String(req.query?.vehicleType || "").trim();
  const minKg = req.query?.minCapacityKg != null ? Number(req.query.minCapacityKg) : null;
  const availableFrom = String(req.query?.availableFrom || "").trim();
  const params = [];
  const clauses = ["s.status = 'open'"];
  if (origin) {
    params.push(`%${origin}%`);
    clauses.push(`s.origin ILIKE $${params.length}`);
  }
  if (destination) {
    params.push(`%${destination}%`);
    clauses.push(`s.destination ILIKE $${params.length}`);
  }
  if (vehicleType) {
    params.push(`%${vehicleType}%`);
    clauses.push(`s.vehicle_type ILIKE $${params.length}`);
  }
  if (minKg != null && Number.isFinite(minKg) && minKg > 0) {
    params.push(minKg);
    clauses.push(`s.remaining_space_kg >= $${params.length}`);
  }
  if (availableFrom && /^\d{4}-\d{2}-\d{2}$/.test(availableFrom)) {
    params.push(availableFrom);
    clauses.push(`(s.available_from IS NULL OR s.available_from >= $${params.length}::date)`);
  }
  const { rows } = await dbQuery(
    `SELECT s.id, s.carrier_id AS "carrierId", s.origin, s.destination,
            s.truck_capacity_kg AS "truckCapacityKg", s.remaining_space_kg AS "remainingSpaceKg",
            s.vehicle_type AS "vehicleType", s.rate_per_kg AS "ratePerKg",
            s.available_from AS "availableFrom", s.notes, s.status,
            s.created_at AS "createdAt",
            COALESCE(u.full_name, u.email, 'Carrier') AS "carrierName"
     FROM carrier_space_listings s
     JOIN users u ON u.id = s.carrier_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY s.created_at DESC
     LIMIT 200`,
    params
  );
  return sendSuccess(res, 200, rows);
});

router.get("/mine", protect, requireRole("carrier"), async (req, res) => {
  const { rows } = await dbQuery(
    `SELECT id, carrier_id AS "carrierId", origin, destination,
            truck_capacity_kg AS "truckCapacityKg", remaining_space_kg AS "remainingSpaceKg",
            vehicle_type AS "vehicleType", rate_per_kg AS "ratePerKg",
            available_from AS "availableFrom", notes, status,
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM carrier_space_listings
     WHERE carrier_id = $1
     ORDER BY created_at DESC
     LIMIT 100`,
    [req.auth.userId]
  );
  return sendSuccess(res, 200, rows);
});

const createValidators = [
  body("origin").trim().isLength({ min: 2, max: 120 }),
  body("destination").trim().isLength({ min: 2, max: 120 }),
  body("truckCapacityKg").toFloat().isFloat({ gt: 0 }),
  body("remainingSpaceKg").toFloat().isFloat({ gt: 0 }),
  body("vehicleType").optional().trim().isLength({ min: 2, max: 80 }),
  body("ratePerKg").optional({ nullable: true }).toFloat().isFloat({ min: 0 }),
  body("availableFrom").optional({ nullable: true }).isISO8601().toDate(),
  body("notes").optional().trim().isLength({ max: 500 })
];

router.post(
  "/",
  protect,
  requireRole("carrier"),
  createValidators,
  validate,
  async (req, res) => {
    const user = await userRepo.findById(req.auth.userId);
    if (!user?.isProfileComplete) {
      return sendError(res, 403, "Complete your profile to list available space", null, "PROFILE_INCOMPLETE");
    }
    const {
      origin,
      destination,
      truckCapacityKg,
      remainingSpaceKg,
      vehicleType,
      ratePerKg,
      availableFrom,
      notes
    } = req.body || {};
    const cap = Number(truckCapacityKg);
    const rem = Number(remainingSpaceKg);
    if (rem > cap) return sendError(res, 400, "Remaining space cannot exceed truck capacity");

    const { rows } = await dbQuery(
      `INSERT INTO carrier_space_listings
         (carrier_id, origin, destination, truck_capacity_kg, remaining_space_kg, vehicle_type, rate_per_kg, available_from, notes, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,'open')
       RETURNING id, origin, destination, truck_capacity_kg AS "truckCapacityKg",
                 remaining_space_kg AS "remainingSpaceKg", vehicle_type AS "vehicleType",
                 rate_per_kg AS "ratePerKg", available_from AS "availableFrom", notes, status,
                 created_at AS "createdAt"`,
      [
        req.auth.userId,
        String(origin).trim(),
        String(destination).trim(),
        cap,
        rem,
        String(vehicleType || "Truck").trim(),
        ratePerKg != null ? Number(ratePerKg) : null,
        availableFrom ? new Date(availableFrom).toISOString().slice(0, 10) : null,
        notes ? String(notes).trim() : null
      ]
    );

    await notifyUser({
      receiverId: req.auth.userId,
      senderId: req.auth.userId,
      roleType: "carrier",
      title: "SPACE_LISTED",
      message: `Capacity listed: ${origin} → ${destination}`
    });

    return sendSuccess(res, 201, rows[0], "Created");
  }
);

router.patch(
  "/:id",
  protect,
  requireRole("carrier"),
  [
    param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid id"); })())),
    body("remainingSpaceKg").optional().toFloat().isFloat({ min: 0 }),
    body("status").optional().isIn(["open", "booked", "closed"])
  ],
  validate,
  async (req, res) => {
    const id = req.params.id;
    const { rows: found } = await dbQuery(`SELECT * FROM carrier_space_listings WHERE id = $1`, [id]);
    const row = found[0];
    if (!row) return sendError(res, 404, "Not found");
    if (String(row.carrier_id) !== String(req.auth.userId) && !hasAdminRole(req.auth)) {
      return sendError(res, 403, "Forbidden");
    }
    const rem = req.body.remainingSpaceKg != null ? Number(req.body.remainingSpaceKg) : null;
    const status = req.body.status != null ? String(req.body.status) : null;
    if (rem != null && rem > Number(row.truck_capacity_kg)) {
      return sendError(res, 400, "Remaining space cannot exceed capacity");
    }
    const { rows } = await dbQuery(
      `UPDATE carrier_space_listings
       SET remaining_space_kg = COALESCE($2, remaining_space_kg),
           status = COALESCE($3, status),
           updated_at = now()
       WHERE id = $1
       RETURNING id, origin, destination, truck_capacity_kg AS "truckCapacityKg",
                 remaining_space_kg AS "remainingSpaceKg", vehicle_type AS "vehicleType",
                 rate_per_kg AS "ratePerKg", status, updated_at AS "updatedAt"`,
      [id, rem, status]
    );
    return sendSuccess(res, 200, rows[0]);
  }
);

router.delete(
  "/:id",
  protect,
  requireRole("carrier"),
  [param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid id"); })()))],
  validate,
  async (req, res) => {
    const id = req.params.id;
    const { rowCount } = await dbQuery(
      `DELETE FROM carrier_space_listings WHERE id = $1 AND carrier_id = $2`,
      [id, req.auth.userId]
    );
    if (!rowCount) return sendError(res, 404, "Not found");
    return sendSuccess(res, 200, { ok: true }, "Deleted");
  }
);

module.exports = router;
