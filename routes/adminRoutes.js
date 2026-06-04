const express = require("express");
const { body, param, validationResult } = require("express-validator");
const { protect } = require("../middleware/authMiddleware");
const { requireAdminSession } = require("../middleware/sessionGuards");
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
const { writeAudit } = require("../utils/auditLog");
const { logAdminView } = require("../utils/adminAudit");
const realtimeHub = require("../services/realtimeHub");
const { notifyUser } = require("../utils/notifyEvent");
const { adminSessionAudit } = require("../middleware/adminSessionAudit");
const adminDashboardWidgetRoutes = require("./adminDashboardWidgetRoutes");
const adminFleetRoutes = require("./adminFleetRoutes");

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

router.use(protect, requireAdminSession, adminSessionAudit);

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
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const mime = String(file.mimetype || "").toLowerCase();
    if (!["video/mp4", "video/webm", "video/quicktime"].includes(mime)) {
      return cb(new Error("Only MP4, WebM, or MOV videos are allowed"));
    }
    return cb(null, true);
  }
});

router.post("/demo-video", demoVideoUpload.single("video"), uploadDemoVideo);

router.get("/disputes", disputeController.adminList);
router.patch("/disputes/:id/resolve", disputeController.adminResolve);

router.get("/stats", async (req, res) => {
  try {
    const count = async (sql) => {
      try {
        const { rows } = await query(sql);
        return rows[0]?.c ?? 0;
      } catch (e) {
        if (process.env.NODE_ENV !== "production") {
          // eslint-disable-next-line no-console
          console.warn("[admin/stats] query skipped:", e?.message || e);
        }
        return 0;
      }
    };

    const [
      totalUsers,
      totalLoads,
      totalShipmentsCount,
      totalBids,
      activeShipments,
      totalReviews,
      totalBookings
    ] = await Promise.all([
      count(`SELECT COUNT(*)::int AS c FROM users`),
      count(`SELECT COUNT(*)::int AS c FROM loads`),
      count(`SELECT COUNT(*)::int AS c FROM shipments`),
      count(`SELECT COUNT(*)::int AS c FROM bids`),
      count(
        `SELECT COUNT(*)::int AS c FROM shipments WHERE status IN ('booked','pickedup','intransit','delivered')`
      ),
      count(`SELECT COUNT(*)::int AS c FROM ratings`),
      count(`SELECT COUNT(*)::int AS c FROM bookings`)
    ]);

    return sendSuccess(res, 200, {
      totalUsers,
      totalLoads,
      totalShipments: totalShipmentsCount,
      totalBookings,
      activeShipments,
      totalBids,
      totalReviews
    });
  } catch (err) {
    return sendError(res, 500, err.message || "Server error");
  }
});

const { getAdminDashboardLive } = require("../utils/adminDashboardHandler");
router.use("/dashboard/widgets", adminDashboardWidgetRoutes);
router.use("/fleet", adminFleetRoutes);

const adminFleet = require("../src/controllers/adminFleetController");
router.get("/trucks", adminFleet.listValidators, adminFleet.validate, asyncHandler(adminFleet.list));

router.get("/dashboard/live", getAdminDashboardLive);
router.get("/dashboard", getAdminDashboardLive);

router.get(
  "/users",
  asyncHandler(async (req, res) => {
    const roleFilter = String(req.query?.role || "").trim().toLowerCase();
    const params = [];
    const clauses = [];
    if (roleFilter && ["shipper", "carrier", "admin"].includes(roleFilter)) {
      params.push(roleFilter);
      clauses.push(`$${params.length} = ANY(roles)`);
    }
    if (req.query?.verified === "false") clauses.push("verified = false");
    if (req.query?.verified === "true") clauses.push("verified = true");
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const { rows } = await query(
      `SELECT id, COALESCE(full_name, email) AS name, email,
              cnic_number AS cnic, roles, active_role AS "activeRole",
              blocked, verified, is_profile_complete AS "profileComplete",
              created_at AS "createdAt"
       FROM users
       ${where}
       ORDER BY created_at DESC
       LIMIT 500`,
      params
    );
    logAdminView(req, "admin_view_user", { targetEntity: "users", count: rows.length });
    return sendSuccess(res, 200, rows);
  })
);

router.get(
  "/bids",
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT b.id, b.load_id AS "loadId", l.code AS "loadCode", b.carrier_id AS "carrierId",
              COALESCE(u.full_name, u.email, 'Carrier') AS "carrierName",
              b.amount, b.status, b.created_at AS "createdAt",
              l.origin, l.destination, l.status AS "loadStatus"
       FROM bids b
       JOIN loads l ON l.id = b.load_id
       LEFT JOIN users u ON u.id = b.carrier_id
       ORDER BY b.created_at DESC
       LIMIT 500`
    );
    return sendSuccess(res, 200, rows);
  })
);

router.get(
  "/notifications",
  asyncHandler(async (req, res) => {
    const userId = String(req.query?.userId || "").trim();
    const params = [];
    let filter = "";
    if (userId && isUuid(userId)) {
      params.push(userId);
      filter = `WHERE n.receiver_id = $1`;
    }
    const { rows } = await query(
      `SELECT n.id, n.receiver_id AS "receiverId", n.sender_id AS "senderId",
              n.role_type AS "roleType", n.title, n.message, n.read,
              n.created_at AS "createdAt",
              COALESCE(ru.full_name, ru.email) AS "receiverName",
              COALESCE(su.full_name, su.email) AS "senderName"
       FROM notifications n
       LEFT JOIN users ru ON ru.id = n.receiver_id
       LEFT JOIN users su ON su.id = n.sender_id
       ${filter}
       ORDER BY n.created_at DESC
       LIMIT 300`,
      params
    );
    return sendSuccess(res, 200, rows);
  })
);

router.get(
  "/otp-logs",
  asyncHandler(async (req, res) => {
    const email = String(req.query?.email || "").trim().toLowerCase();
    const params = [];
    let filter = "";
    if (email) {
      params.push(`%${email}%`);
      filter = `WHERE lower(trim(email)) LIKE $1`;
    }
    const { rows } = await query(
      `SELECT id, email, purpose, expires_at AS "expiresAt", consumed_at AS "consumedAt",
              attempt_count AS "attemptCount", created_at AS "createdAt"
       FROM email_otp_challenges
       ${filter}
       ORDER BY created_at DESC
       LIMIT 200`,
      params
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
    logAdminView(req, "admin_view_shipment", { targetEntity: "shipments", count: rows.length });
    return sendSuccess(res, 200, rows);
  })
);

router.get(
  "/carrier-space",
  asyncHandler(async (req, res) => {
    const { rows: listings } = await query(
      `SELECT s.id, s.origin, s.destination, s.status,
              s.remaining_space_kg AS "remainingSpaceKg",
              s.truck_capacity_kg AS "truckCapacityKg",
              s.available_from AS "availableFrom",
              s.created_at AS "createdAt",
              COALESCE(u.full_name, u.email, 'Carrier') AS "carrierName",
              (SELECT COUNT(*)::int FROM carrier_space_requests r
               WHERE r.listing_id = s.id AND r.status = 'request_sent') AS "pendingRequests"
       FROM carrier_space_listings s
       JOIN users u ON u.id = s.carrier_id
       ORDER BY s.updated_at DESC
       LIMIT 500`
    );
    const { rows: requests } = await query(
      `SELECT r.id, r.status, r.requested_kg AS "requestedKg", r.created_at AS "createdAt",
              l.origin, l.destination,
              COALESCE(us.full_name, us.email, 'Shipper') AS "shipperName",
              COALESCE(uc.full_name, uc.email, 'Carrier') AS "carrierName"
       FROM carrier_space_requests r
       JOIN carrier_space_listings l ON l.id = r.listing_id
       JOIN users us ON us.id = r.shipper_id
       JOIN users uc ON uc.id = l.carrier_id
       ORDER BY r.updated_at DESC
       LIMIT 500`
    );
    logAdminView(req, "admin_view_capacity", {
      targetEntity: "carrier_space",
      listings: listings.length,
      requests: requests.length
    });
    return sendSuccess(res, 200, { listings, requests });
  })
);

/** Read-only governance: admins monitor shipments; carriers own status updates. */
router.patch(
  "/shipments/:id/status",
  [
    param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid shipment id"); })())),
    body("status").trim().isLength({ min: 1, max: 32 }).withMessage("status is required"),
    body("force").optional().isBoolean()
  ],
  validate,
  asyncHandler(async (req, res) => {
    if (process.env.NODE_ENV !== "test") {
      // eslint-disable-next-line no-console
      console.warn("[admin] blocked shipment status write", {
        adminId: req.auth?.userId,
        shipmentId: req.params.id,
        attemptedStatus: req.body?.status
      });
    }
    return sendError(
      res,
      403,
      "Admin shipment status changes are disabled. Tracking is carrier-operated (read-only governance).",
      null,
      "ADMIN_SHIPMENT_READ_ONLY"
    );
  })
);

router.patch(
  "/user/:id/role",
  [
    param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid user id"); })())),
    body("activeRole").optional().trim().isIn(["shipper", "carrier", "admin"]),
    body("roles").optional().isArray({ min: 1, max: 3 })
  ],
  validate,
  asyncHandler(async (req, res) => {
    const userId = String(req.params.id);
    const activeRole = req.body.activeRole ? String(req.body.activeRole).trim().toLowerCase() : null;
    const rolesInput = Array.isArray(req.body.roles)
      ? [...new Set(req.body.roles.map((r) => String(r).trim().toLowerCase()).filter(Boolean))]
      : null;

    const { rows: existing } = await query(`SELECT id, roles, active_role FROM users WHERE id = $1`, [userId]);
    if (!existing[0]) return sendError(res, 404, "User not found");

    const { sanitizeRolesForStorage, validateRoleMutation } = require("../utils/rolePolicy");
    const currentUser = {
      id: userId,
      roles: existing[0].roles,
      activeRole: existing[0].active_role
    };

    const policy = validateRoleMutation(
      currentUser,
      activeRole || existing[0].active_role,
      rolesInput?.length ? rolesInput : null
    );
    if (!policy.ok) {
      return sendError(res, 403, policy.message, null, policy.code);
    }

    const roles = policy.roles;
    const nextActive = policy.activeRole;

    const { rows } = await query(
      `UPDATE users SET roles = $2::text[], active_role = $3, updated_at = now() WHERE id = $1
       RETURNING id, COALESCE(full_name, email) AS name, email, roles, active_role AS "activeRole", blocked, verified`,
      [userId, roles, nextActive]
    );
    void writeAudit({
      actorUserId: req.auth.userId,
      action: "admin.user.role_updated",
      targetEntity: "user",
      targetId: userId,
      metadata: { activeRole: nextActive, roles }
    });
    return sendSuccess(res, 200, rows[0], "Role updated");
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
    void writeAudit({
      actorUserId: req.auth.userId,
      action: "admin.user.deleted",
      targetEntity: "user",
      targetId
    });
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
  if (!rows[0]) return sendError(res, 404, "Not found", null, "NOT_FOUND");
  void writeAudit({
    actorUserId: req.auth.userId,
    action: Boolean(blocked) ? "admin.user.blocked" : "admin.user.unblocked",
    targetEntity: "user",
    targetId: req.params.id
  });
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
  const verifiedBool = Boolean(verified);
  const { rows } = await query(
    `UPDATE users SET verified = $2,
       is_profile_complete = (
         COALESCE(cnic_image, '') <> '' AND COALESCE(cnic_image_back, '') <> '' AND $2
       ),
       updated_at = now()
     WHERE id = $1
     RETURNING id, COALESCE(full_name, email) AS name, email, cnic_number AS cnic, roles, blocked, verified,
               cnic_image AS "cnicImage", cnic_image_back AS "cnicImageBack", is_profile_complete AS "profileComplete"`,
    [req.params.id, verifiedBool]
  );
  if (!rows[0]) return sendError(res, 404, "Not found", null, "NOT_FOUND");
  void writeAudit({
    actorUserId: req.auth.userId,
    action: Boolean(verified) ? "admin.user.verified" : "admin.user.unverified",
    targetEntity: "user",
    targetId: req.params.id
  });
  const target = rows[0];
  const roles = Array.isArray(target.roles) ? target.roles : [];
  const roleType = roles.includes("carrier") ? "carrier" : roles.includes("shipper") ? "shipper" : "admin";
  void notifyUser({
    receiverId: target.id,
    senderId: req.auth.userId,
    roleType,
    title: verified ? "VERIFICATION_APPROVED" : "VERIFICATION_REJECTED",
    type: verified ? "VERIFICATION_APPROVED" : "VERIFICATION_REJECTED",
    message: verified
      ? "Your identity verification has been approved."
      : "Your verification was not approved. Please contact support."
  });
  return sendSuccess(res, 200, { ok: true, user: rows[0] });
});

router.delete(
  "/loads/:id",
  asyncHandler(async (req, res) => {
    const id = String(req.params.id || "");
    if (!isUuid(id)) return sendError(res, 400, "Invalid load id");
    const { rows } = await query(`DELETE FROM loads WHERE id = $1 RETURNING id`, [id]);
    if (!rows[0]) return sendError(res, 404, "Not found");
    void writeAudit({
      actorUserId: req.auth.userId,
      action: "admin.load.deleted",
      targetEntity: "load",
      targetId: id
    });
    return sendSuccess(res, 200, { ok: true });
  })
);

module.exports = router;
