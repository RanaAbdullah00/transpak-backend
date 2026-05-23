const express = require("express");
const { body, param, validationResult } = require("express-validator");
const { protect, requireRole } = require("../middleware/authMiddleware");
const { sendSuccess, sendError } = require("../utils/apiResponse");
const { query, getPool } = require("../db/pool");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { adminUpload: uploadDemoVideo } = require("../src/controllers/demoVideoController");
const disputeController = require("../src/controllers/disputeController");
const {
  normalizeShipmentStatus,
  validateShipmentTransition
} = require("../utils/shipmentStatus");
const { asyncHandler } = require("../utils/asyncHandler");

const router = express.Router();

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

router.use(protect, requireRole("admin"));

const uploadsDir = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const demoVideoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || "") || ".mp4";
      cb(null, `demo_video_${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 }
});

router.post("/demo-video", demoVideoUpload.single("video"), uploadDemoVideo);

router.get("/disputes", disputeController.adminList);
router.patch("/disputes/:id/resolve", disputeController.adminResolve);

router.get("/stats", async (req, res) => {
  try {
    const [
      totalUsers,
      totalLoads,
      totalBids,
      activeShipments,
      totalReviews,
      totalBookings
    ] = await Promise.all([
      query(`SELECT COUNT(*)::int AS c FROM users`),
      query(`SELECT COUNT(*)::int AS c FROM loads`),
      query(`SELECT COUNT(*)::int AS c FROM bids`),
      query(`SELECT COUNT(*)::int AS c FROM shipments WHERE status IN ('booked','pickedup','intransit','delivered')`),
      query(`SELECT COUNT(*)::int AS c FROM ratings`),
      query(`SELECT COUNT(*)::int AS c FROM bookings`)
    ]);
    return sendSuccess(res, 200, {
      totalUsers: totalUsers.rows[0].c,
      totalLoads: totalLoads.rows[0].c,
      totalShipments: totalLoads.rows[0].c,
      totalBookings: totalBookings.rows[0].c,
      activeShipments: activeShipments.rows[0].c,
      totalBids: totalBids.rows[0].c,
      totalReviews: totalReviews.rows[0].c
    });
  } catch (err) {
    return sendError(res, 500, err.message || "Server error");
  }
});

router.get(
  "/users",
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT id, COALESCE(full_name, email) AS name, email,
              cnic_number AS cnic, roles, blocked, verified
       FROM users
       ORDER BY created_at DESC
       LIMIT 500`
    );
    return sendSuccess(res, 200, rows);
  })
);

router.get(
  "/loads",
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT id, code, cargo, origin, destination,
              pickup_date AS "pickupDate", status,
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM loads
       ORDER BY created_at DESC
       LIMIT 500`
    );
    return sendSuccess(res, 200, rows);
  })
);

router.get(
  "/shipments",
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT s.id,
              l.id AS "loadId",
              l.code,
              l.origin,
              l.destination,
              s.status,
              l.status AS "loadStatus"
       FROM shipments s
       INNER JOIN loads l ON l.id = s.load_id
       ORDER BY s.updated_at DESC
       LIMIT 500`
    );
    return sendSuccess(res, 200, rows);
  })
);

router.patch(
  "/shipments/:id/status",
  [
    param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid shipment id"); })())),
    body("status").trim().isLength({ min: 1, max: 32 }).withMessage("status is required")
  ],
  validate,
  asyncHandler(async (req, res) => {
    const shipmentId = String(req.params.id);
    const nextStatus = normalizeShipmentStatus(req.body.status);
    if (!nextStatus) return sendError(res, 400, "Invalid status");

    const { rows: existing } = await query(
      `SELECT s.id, s.status, s.load_id AS "loadId", l.status AS "loadStatus", l.code
       FROM shipments s
       INNER JOIN loads l ON l.id = s.load_id
       WHERE s.id = $1`,
      [shipmentId]
    );
    if (!existing[0]) return sendError(res, 404, "Shipment not found");

    const current = existing[0].status;
    const check = validateShipmentTransition(current, nextStatus);
    if (!check.ok) return sendError(res, 400, check.message || "Invalid transition");

    const { rows } = await query(
      `UPDATE shipments
       SET status = $2::shipment_status, updated_at = now()
       WHERE id = $1
       RETURNING id, load_id AS "loadId", status`,
      [shipmentId, nextStatus]
    );

    await query(
      `INSERT INTO shipment_events (shipment_id, status, note)
       VALUES ($1, $2::shipment_status, $3)`,
      [shipmentId, nextStatus, "Updated by admin"]
    );

    let loadStatus = existing[0].loadStatus;
    if (nextStatus === "delivered" || nextStatus === "closed") {
      const { rows: loadRows } = await query(
        `UPDATE loads SET status = 'closed', updated_at = now() WHERE id = $1 RETURNING status`,
        [existing[0].loadId]
      );
      loadStatus = loadRows[0]?.status || loadStatus;
    } else if (nextStatus === "booked" && loadStatus === "open") {
      const { rows: loadRows } = await query(
        `UPDATE loads SET status = 'booked', updated_at = now() WHERE id = $1 RETURNING status`,
        [existing[0].loadId]
      );
      loadStatus = loadRows[0]?.status || loadStatus;
    }

    return sendSuccess(res, 200, {
      ...rows[0],
      loadStatus,
      code: existing[0].code
    });
  })
);

router.delete(
  "/user/:id",
  [param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid user id"); })()))],
  validate,
  async (req, res) => {
    const targetId = String(req.params.id);
    if (targetId === String(req.auth.userId)) return sendError(res, 403, "Cannot delete your own account");

    const { rows: roleRows } = await query(`SELECT roles FROM users WHERE id = $1`, [targetId]);
    if (!roleRows[0]) return sendError(res, 404, "Not found");
    const roles = Array.isArray(roleRows[0].roles) ? roleRows[0].roles : [];
    if (roles.includes("admin")) return sendError(res, 403, "Cannot delete an admin account");

    await query(`DELETE FROM users WHERE id = $1`, [targetId]);
    return sendSuccess(res, 200, { ok: true }, "User deleted");
  }
);

router.patch(
  "/users/:id/block",
  [
    param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid user id"); })())),
    body("blocked").isBoolean().withMessage("blocked must be boolean")
  ],
  validate,
  async (req, res) => {
  const { blocked } = req.body || {};
  const { rows } = await query(
    `UPDATE users SET blocked = $2, updated_at = now()
     WHERE id = $1
     RETURNING id, COALESCE(full_name, email) AS name, email, cnic_number AS cnic, roles, blocked, verified`,
    [req.params.id, Boolean(blocked)]
  );
  if (!rows[0]) return sendError(res, 404, "Not found");
  return sendSuccess(res, 200, { ok: true, user: rows[0] });
});

router.patch(
  "/users/:id/verify",
  [
    param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid user id"); })())),
    body("verified").isBoolean().withMessage("verified must be boolean")
  ],
  validate,
  async (req, res) => {
  const { verified } = req.body || {};
  const { rows } = await query(
    `UPDATE users SET verified = $2, updated_at = now()
     WHERE id = $1
     RETURNING id, COALESCE(full_name, email) AS name, email, cnic_number AS cnic, roles, blocked, verified`,
    [req.params.id, Boolean(verified)]
  );
  if (!rows[0]) return sendError(res, 404, "Not found");
  return sendSuccess(res, 200, { ok: true, user: rows[0] });
});

router.delete(
  "/loads/:id",
  asyncHandler(async (req, res) => {
    const id = String(req.params.id || "");
    if (!isUuid(id)) return sendError(res, 400, "Invalid load id");
    const { rows } = await query(`DELETE FROM loads WHERE id = $1 RETURNING id`, [id]);
    if (!rows[0]) return sendError(res, 404, "Not found");
    return sendSuccess(res, 200, { ok: true });
  })
);

module.exports = router;
