const express = require("express");
const { body, param, query, validationResult } = require("express-validator");
const { protect, requireAnyRole, requireRole } = require("../middleware/authMiddleware");
const { sendSuccess, sendError } = require("../utils/apiResponse");
const { query: dbQuery } = require("../db/pool");
const userRepo = require("../repositories/userRepo");
const { notifyUser, notifyAdmins } = require("../utils/notifyEvent");
const { buildDedupeKey, newEventId } = require("../utils/realtimeDispatch");
const { emitContractDispatch, emitContractEntityDispatch } = require("../utils/eventContractRegistry");
const {
  canMutateCarrierSpaceListing,
  hasAdminRole,
  sendForbidden,
  FORBIDDEN_CODES
} = require("../utils/resourceAuth");
const {
  closeCapacityListing,
  reopenCapacityListing,
  expireCapacityListing
} = require("../utils/capacityListingLifecycle");
const { validateAvailabilitySlots } = require("../utils/availabilitySlots");
const { withIdempotencyKey } = require("../middleware/withIdempotencyKey");

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

router.get("/", protect, requireAnyRole(["shipper", "admin"]), async (req, res) => {
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
    clauses.push(`(s.available_from IS NULL OR s.available_from <= $${params.length}::date)`);
  }
  const roles = req.auth?.roles || [];
  if (!hasAdminRole(req.auth)) {
    params.push(req.auth.userId);
    clauses.push(`s.carrier_id <> $${params.length}`);
  }
  clauses.push(`NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(s.availability_slots, '[]'::jsonb)) elem
    WHERE elem->>'type' = 'visibility'
      AND elem->>'visibleUntil' IS NOT NULL
      AND (elem->>'visibleUntil')::timestamptz < now()
  )`);
  const { rows } = await dbQuery(
    `SELECT s.id, s.carrier_id AS "carrierId", s.origin, s.destination,
            s.truck_capacity_kg AS "truckCapacityKg", s.remaining_space_kg AS "remainingSpaceKg",
            s.vehicle_type AS "vehicleType", s.rate_per_kg AS "ratePerKg",
            s.available_from AS "availableFrom", s.availability_slots AS "availabilitySlots", s.notes, s.status,
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
            available_from AS "availableFrom", availability_slots AS "availabilitySlots", notes, status,
            created_at AS "createdAt", updated_at AS "updatedAt",
            (SELECT COUNT(*)::int FROM carrier_space_requests r
             WHERE r.listing_id = carrier_space_listings.id
               AND r.status = 'request_sent') AS "pendingRequestCount",
            (SELECT COUNT(*)::int FROM carrier_space_requests r
             WHERE r.listing_id = carrier_space_listings.id
               AND r.status IN ('active', 'in_transit', 'completed')) AS "acceptedRequestCount",
            (SELECT COUNT(*)::int FROM carrier_space_requests r
             WHERE r.listing_id = carrier_space_listings.id
               AND r.status IN ('active', 'in_transit')) AS "activeRequestCount"
     FROM carrier_space_listings
     WHERE carrier_id = $1
       AND status NOT IN ('closed', 'expired')
       AND NOT (
         status = 'open'
         AND (
           (available_from IS NOT NULL AND available_from < CURRENT_DATE)
           OR EXISTS (
             SELECT 1
             FROM jsonb_array_elements(COALESCE(availability_slots, '[]'::jsonb)) elem
             WHERE elem->>'type' = 'visibility'
               AND elem->>'visibleUntil' IS NOT NULL
               AND (elem->>'visibleUntil')::timestamptz < now()
           )
         )
       )
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
  body("availabilitySlots").optional({ nullable: true }).isArray({ max: 12 }),
  body("notes").optional().trim().isLength({ max: 500 })
];

router.post(
  "/",
  protect,
  requireRole("carrier"),
  withIdempotencyKey("capacity_post"),
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
      availabilitySlots,
      notes
    } = req.body || {};
    const slotCheck = validateAvailabilitySlots(availabilitySlots);
    if (!slotCheck.ok) return sendError(res, 400, slotCheck.message, null, "INVALID_SLOTS");
    const cap = Number(truckCapacityKg);
    const rem = Number(remainingSpaceKg);
    if (rem > cap) return sendError(res, 400, "Remaining space cannot exceed truck capacity");

    const { rows } = await dbQuery(
      `INSERT INTO carrier_space_listings
         (carrier_id, origin, destination, truck_capacity_kg, remaining_space_kg, vehicle_type, rate_per_kg, available_from, availability_slots, notes, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9::jsonb,$10,'open')
       RETURNING id, origin, destination, truck_capacity_kg AS "truckCapacityKg",
                 remaining_space_kg AS "remainingSpaceKg", vehicle_type AS "vehicleType",
                 rate_per_kg AS "ratePerKg", available_from AS "availableFrom",
                 availability_slots AS "availabilitySlots", notes, status,
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
        slotCheck.value ? JSON.stringify(slotCheck.value) : null,
        notes ? String(notes).trim() : null
      ]
    );

    void notifyUser({
      receiverId: req.auth.userId,
      senderId: req.auth.userId,
      roleType: "carrier",
      title: "SPACE_LISTED",
      type: "SPACE_LISTED",
      message: `Capacity listed: ${origin} → ${destination}`
    });

    emitContractDispatch({
      eventId: newEventId(),
      type: "SPACE_LISTED",
      receiverId: req.auth.userId,
      roleType: "carrier",
      entityType: "space",
      entityId: rows[0].id,
      payload: { listingId: rows[0].id, origin, destination, status: "open" }
    });
    emitContractEntityDispatch({
      entityType: "space",
      entityId: rows[0].id,
      type: "SPACE_LISTED",
      eventId: newEventId(),
      payload: { listingId: rows[0].id, origin, destination }
    });

    void notifyAdmins({
      senderId: req.auth.userId,
      title: "SPACE_LISTED",
      type: "SPACE_LISTED",
      message: `[Platform] Capacity listed: ${origin} → ${destination}`,
      idempotencyKey: buildDedupeKey(["ADMIN", "SPACE_LISTED", rows[0].id])
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
    body("origin").optional().trim().isLength({ min: 2, max: 120 }),
    body("destination").optional().trim().isLength({ min: 2, max: 120 }),
    body("truckCapacityKg").optional().toFloat().isFloat({ gt: 0 }),
    body("remainingSpaceKg").optional().toFloat().isFloat({ min: 0 }),
    body("vehicleType").optional().trim().isLength({ min: 2, max: 80 }),
    body("ratePerKg").optional({ nullable: true }).toFloat().isFloat({ min: 0 }),
    body("availableFrom").optional({ nullable: true }).isISO8601().toDate(),
    body("availabilitySlots").optional({ nullable: true }).isArray({ max: 12 }),
    body("notes").optional().trim().isLength({ max: 500 })
  ],
  validate,
  async (req, res) => {
    const id = req.params.id;
    const { rows: found } = await dbQuery(`SELECT * FROM carrier_space_listings WHERE id = $1`, [id]);
    const row = found[0];
    if (!row) return sendError(res, 404, "Not found");
    if (!canMutateCarrierSpaceListing(row, req.auth)) {
      return sendForbidden(res, "You do not own this listing", FORBIDDEN_CODES.FORBIDDEN_OWNER);
    }
    if (row.status !== "open") {
      return sendError(res, 409, "Only open listings can be edited", null, "LISTING_LOCKED");
    }
    const { rows: engaged } = await dbQuery(
      `SELECT 1 FROM carrier_space_requests
       WHERE listing_id = $1 AND status IN ('active', 'in_transit', 'delivered', 'completed', 'accepted')
       LIMIT 1`,
      [id]
    );
    if (engaged.length) {
      return sendError(res, 409, "Listing has accepted requests and cannot be edited", null, "LISTING_LOCKED");
    }

    const rem = req.body.remainingSpaceKg != null ? Number(req.body.remainingSpaceKg) : null;
    const cap = req.body.truckCapacityKg != null ? Number(req.body.truckCapacityKg) : null;
    const resolvedCap = cap != null ? cap : Number(row.truck_capacity_kg);
    const resolvedRem = rem != null ? rem : Number(row.remaining_space_kg);
    if (resolvedRem > resolvedCap) {
      return sendError(res, 400, "Remaining space cannot exceed capacity");
    }

    const availableFrom =
      req.body.availableFrom === null
        ? null
        : req.body.availableFrom
          ? new Date(req.body.availableFrom).toISOString().slice(0, 10)
          : undefined;

    let availabilitySlotsValue = undefined;
    if (req.body.availabilitySlots !== undefined) {
      const slotCheck = validateAvailabilitySlots(req.body.availabilitySlots);
      if (!slotCheck.ok) return sendError(res, 400, slotCheck.message, null, "INVALID_SLOTS");
      availabilitySlotsValue = slotCheck.value;
    }

    const rateSent = req.body.ratePerKg !== undefined;
    const rateValue = rateSent ? (req.body.ratePerKg == null ? null : Number(req.body.ratePerKg)) : null;

    const { rows } = await dbQuery(
      `UPDATE carrier_space_listings
       SET origin = COALESCE($2, origin),
           destination = COALESCE($3, destination),
           truck_capacity_kg = COALESCE($4, truck_capacity_kg),
           remaining_space_kg = COALESCE($5, remaining_space_kg),
           vehicle_type = COALESCE($6, vehicle_type),
           rate_per_kg = CASE WHEN $7 THEN $8 ELSE rate_per_kg END,
           available_from = CASE WHEN $9::text = '__skip__' THEN available_from WHEN $9 IS NULL THEN NULL ELSE $9::date END,
           availability_slots = CASE WHEN $10::text = '__skip__' THEN availability_slots WHEN $10 IS NULL THEN NULL ELSE $10::jsonb END,
           notes = CASE WHEN $11::text IS NOT NULL THEN $11 ELSE notes END,
           updated_at = now()
       WHERE id = $1
       RETURNING id, origin, destination, truck_capacity_kg AS "truckCapacityKg",
                 remaining_space_kg AS "remainingSpaceKg", vehicle_type AS "vehicleType",
                 rate_per_kg AS "ratePerKg", available_from AS "availableFrom",
                 availability_slots AS "availabilitySlots", notes, status,
                 updated_at AS "updatedAt"`,
      [
        id,
        req.body.origin != null ? String(req.body.origin).trim() : null,
        req.body.destination != null ? String(req.body.destination).trim() : null,
        cap,
        rem,
        req.body.vehicleType != null ? String(req.body.vehicleType).trim() : null,
        rateSent,
        rateValue,
        availableFrom === undefined ? "__skip__" : availableFrom,
        availabilitySlotsValue === undefined
          ? "__skip__"
          : availabilitySlotsValue
            ? JSON.stringify(availabilitySlotsValue)
            : null,
        req.body.notes !== undefined ? (req.body.notes ? String(req.body.notes).trim() : null) : null
      ]
    );
    return sendSuccess(res, 200, rows[0]);
  }
);

function listingLifecycleHandler(action) {
  return async (req, res) => {
    try {
      const id = req.params.id;
      const actor = { userId: req.auth.userId, isAdmin: hasAdminRole(req.auth) };
      const updated = await action(id, actor);
      if (updated && (updated.status === "closed" || updated.status === "expired")) {
        void notifyAdmins({
          senderId: req.auth.userId,
          title: updated.status === "expired" ? "SPACE_EXPIRED" : "SPACE_CLOSED",
          type: updated.status === "expired" ? "SPACE_EXPIRED" : "SPACE_CLOSED",
          message: `[Platform] Capacity listing ${updated.status}: ${updated.origin} → ${updated.destination}`,
          idempotencyKey: buildDedupeKey(["ADMIN", updated.status.toUpperCase(), id])
        });
      }
      return sendSuccess(res, 200, updated);
    } catch (err) {
      const status = err.statusCode || 500;
      return sendError(res, status, err.message, null, err.code || "SERVER_ERROR");
    }
  };
}

router.post(
  "/:id/close",
  protect,
  requireRole("carrier"),
  [param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid id"); })()))],
  validate,
  listingLifecycleHandler(closeCapacityListing)
);

router.post(
  "/:id/reopen",
  protect,
  requireRole("carrier"),
  [param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid id"); })()))],
  validate,
  listingLifecycleHandler(reopenCapacityListing)
);

router.post(
  "/:id/expire",
  protect,
  requireAnyRole(["carrier", "admin"]),
  [param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid id"); })()))],
  validate,
  listingLifecycleHandler(expireCapacityListing)
);

router.delete(
  "/:id",
  protect,
  requireRole("carrier"),
  [param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid id"); })()))],
  validate,
  async (req, res) => {
    const id = req.params.id;
    const { rows: found } = await dbQuery(
      `SELECT origin, destination, status FROM carrier_space_listings WHERE id = $1 AND carrier_id = $2`,
      [id, req.auth.userId]
    );
    if (!found[0]) return sendError(res, 404, "Not found");
    if (found[0].status !== "open") {
      return sendError(res, 409, "Only open listings can be deleted", null, "LISTING_LOCKED");
    }
    const { rows: activeAgreements } = await dbQuery(
      `SELECT 1 FROM carrier_space_requests
       WHERE listing_id = $1 AND status IN ('active', 'in_transit')
       LIMIT 1`,
      [id]
    );
    if (activeAgreements.length) {
      return sendError(
        res,
        409,
        "Listing has an active agreement and cannot be deleted",
        null,
        "LISTING_ACTIVE"
      );
    }
    const { rowCount } = await dbQuery(
      `DELETE FROM carrier_space_listings WHERE id = $1 AND carrier_id = $2`,
      [id, req.auth.userId]
    );
    if (!rowCount) return sendError(res, 404, "Not found");
    void notifyAdmins({
      senderId: req.auth.userId,
      title: "SPACE_CLOSED",
      type: "SPACE_CLOSED",
      message: `[Platform] Capacity listing removed: ${found[0].origin} → ${found[0].destination}`,
      idempotencyKey: buildDedupeKey(["ADMIN", "SPACE_CLOSED", id])
    });
    return sendSuccess(res, 200, { ok: true }, "Deleted");
  }
);

module.exports = router;
