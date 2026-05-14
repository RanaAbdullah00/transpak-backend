const { body, param, validationResult } = require("express-validator");
const { sendSuccess, sendError } = require("../../utils/apiResponse");
const { query } = require("../../db/pool");
const { safeDestroyReplacedUrl } = require("../../utils/cloudinaryUrl");

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

const createValidators = [
  body("engineNumber").trim().isLength({ min: 2, max: 80 }).withMessage("engineNumber is required"),
  body("truckType").trim().isLength({ min: 2, max: 80 }).withMessage("truckType is required"),
  body("licensePlate").trim().isLength({ min: 2, max: 80 }).withMessage("licensePlate is required"),
  body("capacity").optional().toFloat().isFloat({ min: 0 }).withMessage("capacity must be non-negative"),
  body("truckCardFrontImage").trim().isLength({ min: 1 }).withMessage("truckCardFrontImage is required"),
  body("truckCardBackImage").trim().isLength({ min: 1 }).withMessage("truckCardBackImage is required")
];

async function create(req, res) {
  try {
    const { engineNumber, truckType, capacity, licensePlate, truckCardFrontImage, truckCardBackImage } = req.body || {};
    const { rows } = await query(
      `INSERT INTO trucks (user_id, engine_number, truck_type, capacity, license_plate, truck_card_front_image, truck_card_back_image)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, engine_number AS "engineNumber", truck_type AS "truckType", capacity, license_plate AS "licensePlate",
                 truck_card_front_image AS "truckCardFrontImage", truck_card_back_image AS "truckCardBackImage",
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        req.auth.userId,
        String(engineNumber).trim(),
        String(truckType).trim(),
        Number(capacity || 0),
        String(licensePlate).trim(),
        String(truckCardFrontImage).trim(),
        String(truckCardBackImage).trim()
      ]
    );
    return sendSuccess(res, 201, rows[0], "Created");
  } catch (err) {
    // unique violation -> conflict
    if (String(err.code) === "23505") return sendError(res, 409, "Truck already exists");
    return sendError(res, 500, err.message || "Server error");
  }
}

async function mine(req, res) {
  const { rows } = await query(
    `SELECT id, engine_number AS "engineNumber", truck_type AS "truckType", capacity,
            license_plate AS "licensePlate",
            truck_card_front_image AS "truckCardFrontImage",
            truck_card_back_image AS "truckCardBackImage",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM trucks
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 100`,
    [req.auth.userId]
  );
  return sendSuccess(res, 200, rows);
}

const updateValidators = [
  param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid truck id"); })())),
  body("engineNumber").optional().trim().isLength({ min: 2, max: 80 }).withMessage("Invalid engineNumber"),
  body("truckType").optional().trim().isLength({ min: 2, max: 80 }).withMessage("Invalid truckType"),
  body("capacity").optional().toFloat().isFloat({ min: 0 }).withMessage("capacity must be non-negative"),
  body("licensePlate").optional().trim().isLength({ min: 2, max: 80 }).withMessage("Invalid licensePlate"),
  body("truckCardFrontImage").optional().trim().isLength({ min: 1 }).withMessage("Invalid truckCardFrontImage"),
  body("truckCardBackImage").optional().trim().isLength({ min: 1 }).withMessage("Invalid truckCardBackImage")
];

async function update(req, res) {
  try {
    const id = String(req.params.id);
    const { rows: found } = await query(
      `SELECT id, user_id, truck_card_front_image, truck_card_back_image FROM trucks WHERE id = $1`,
      [id]
    );
    const truck = found[0];
    if (!truck) return sendError(res, 404, "Not found");
    const roles = req.auth?.roles || [];
    const isAdmin = roles.includes("admin");
    if (!isAdmin && String(truck.user_id) !== String(req.auth.userId)) return sendError(res, 403, "Forbidden");

    const { engineNumber, truckType, capacity, licensePlate, truckCardFrontImage, truckCardBackImage } = req.body || {};
    const uidStr = String(req.auth.userId);
    const { rows } = await query(
      `UPDATE trucks
       SET engine_number = COALESCE($2, engine_number),
           truck_type = COALESCE($3, truck_type),
           capacity = COALESCE($4, capacity),
           license_plate = COALESCE($5, license_plate),
           truck_card_front_image = COALESCE($6, truck_card_front_image),
           truck_card_back_image = COALESCE($7, truck_card_back_image),
           updated_at = now()
       WHERE id = $1
       RETURNING id, engine_number AS "engineNumber", truck_type AS "truckType", capacity,
                 license_plate AS "licensePlate",
                 truck_card_front_image AS "truckCardFrontImage",
                 truck_card_back_image AS "truckCardBackImage",
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        id,
        engineNumber != null ? String(engineNumber).trim() : null,
        truckType != null ? String(truckType).trim() : null,
        capacity != null ? Number(capacity || 0) : null,
        licensePlate != null ? String(licensePlate).trim() : null,
        truckCardFrontImage != null ? String(truckCardFrontImage).trim() : null,
        truckCardBackImage != null ? String(truckCardBackImage).trim() : null
      ]
    );
    const updated = rows[0];
    if (updated) {
      if (truckCardFrontImage != null && truck.truck_card_front_image && truck.truck_card_front_image !== updated.truckCardFrontImage) {
        void safeDestroyReplacedUrl(uidStr, truck.truck_card_front_image, updated.truckCardFrontImage, "image");
      }
      if (truckCardBackImage != null && truck.truck_card_back_image && truck.truck_card_back_image !== updated.truckCardBackImage) {
        void safeDestroyReplacedUrl(uidStr, truck.truck_card_back_image, updated.truckCardBackImage, "image");
      }
    }
    return sendSuccess(res, 200, updated);
  } catch (err) {
    if (String(err.code) === "23505") return sendError(res, 409, "Truck already exists");
    return sendError(res, 500, err.message || "Server error");
  }
}

module.exports = {
  validate,
  createValidators,
  updateValidators,
  create,
  mine,
  update
};

