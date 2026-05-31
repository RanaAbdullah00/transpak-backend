const { body, param, validationResult } = require("express-validator");
const { sendSuccess, sendError } = require("../../utils/apiResponse");
const { canMutateTruck, sendForbidden, FORBIDDEN_CODES } = require("../../utils/resourceAuth");
const { query } = require("../../db/pool");
const { safeDestroyReplacedUrl } = require("../../utils/cloudinaryUrl");
const { isAllowedImageUrl } = require("../../utils/imageUrl");
const { notifyUser, notifyAdmins } = require("../../utils/notifyEvent");
const { buildDedupeKey } = require("../../utils/realtimeDispatch");
const { validateLicensePlate, validateCapacity, validateEngineNumber } = require("../../utils/truckValidation");
const { writeAudit } = require("../../utils/auditLog");
const fleetRepo = require("../../utils/fleetRepo");
const {
  TRUCK_STATUS,
  apiTruckStatus,
  isApprovedForMatching,
  isSuspended,
  hasRequiredDocuments
} = require("../../utils/truckLifecycle");

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendError(
      res,
      400,
      errors.array()[0]?.msg || "Validation error",
      { fields: errors.array().map((e) => e.path) },
      "VALIDATION_ERROR"
    );
  }
  return next();
}

function enrichTruck(row) {
  if (!row) return null;
  return {
    ...row,
    statusLabel: apiTruckStatus(row.status),
    matchingEligible: isApprovedForMatching(row.status),
    documentsComplete: hasRequiredDocuments(row)
  };
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
    const {
      engineNumber,
      truckType,
      capacity,
      licensePlate,
      truckCardFrontImage,
      truckCardBackImage,
      chassisNumber
    } = req.body || {};

    const plateCheck = validateLicensePlate(licensePlate);
    if (!plateCheck.ok) return sendError(res, 400, plateCheck.message, null, "VALIDATION_ERROR");
    const capCheck = validateCapacity(capacity ?? 0);
    if (!capCheck.ok) return sendError(res, 400, capCheck.message, null, "VALIDATION_ERROR");
    const engineCheck = validateEngineNumber(engineNumber);
    if (!engineCheck.ok) return sendError(res, 400, engineCheck.message, null, "VALIDATION_ERROR");

    if (!isAllowedImageUrl(truckCardFrontImage) || !isAllowedImageUrl(truckCardBackImage)) {
      return sendError(
        res,
        400,
        "Truck images must be secure HTTPS URLs (upload via /api/upload/media first)",
        null,
        "INVALID_IMAGE_URL"
      );
    }

    const plate = plateCheck.value;
    const engine = engineCheck.value;
    const chassis = chassisNumber != null ? String(chassisNumber).trim() : "";

    const dup = await fleetRepo.findDuplicate({ licensePlate: plate, engineNumber: engine, chassisNumber: chassis });
    if (dup) {
      return sendError(res, 409, "A truck with this plate or engine number already exists", null, "TRUCK_EXISTS");
    }

    const totalFleet = await fleetRepo.countTrucks(req.auth.userId);
    const isFirst = totalFleet === 0;

    const { rows } = await query(
      `INSERT INTO trucks (
         user_id, engine_number, truck_type, capacity, license_plate,
         truck_card_front_image, truck_card_back_image, chassis_number, status, is_default
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, engine_number AS "engineNumber", truck_type AS "truckType", capacity,
                 license_plate AS "licensePlate", chassis_number AS "chassisNumber",
                 status, is_default AS "isDefault",
                 truck_card_front_image AS "truckCardFrontImage", truck_card_back_image AS "truckCardBackImage",
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        req.auth.userId,
        engine,
        String(truckType).trim(),
        capCheck.value,
        plate,
        String(truckCardFrontImage).trim(),
        String(truckCardBackImage).trim(),
        chassis || null,
        TRUCK_STATUS.PENDING,
        isFirst
      ]
    );

    const truck = enrichTruck(rows[0]);
    await writeAudit({
      actorUserId: req.auth.userId,
      action: "truck.created",
      targetEntity: "truck",
      targetId: truck?.id,
      metadata: { plate, truckType: String(truckType).trim(), status: TRUCK_STATUS.PENDING }
    });
    await notifyUser({
      receiverId: req.auth.userId,
      senderId: req.auth.userId,
      roleType: "carrier",
      title: "TRUCK_UPDATED",
      message: "Truck submitted — awaiting admin approval"
    });
    void notifyAdmins({
      senderId: req.auth.userId,
      title: "TRUCK_PENDING",
      type: "TRUCK_PENDING",
      message: `[Platform] Truck ${plate} submitted for approval`,
      idempotencyKey: buildDedupeKey(["ADMIN", "TRUCK_PENDING", truck?.id || plate])
    });
    return sendSuccess(res, 201, truck, "Created");
  } catch (err) {
    if (String(err.code) === "23505") return sendError(res, 409, "Truck already exists", null, "TRUCK_EXISTS");
    return sendError(res, 500, err.message || "Server error", null, "SERVER_ERROR");
  }
}

async function mine(req, res) {
  const page = parseInt(req.query?.page, 10) || 1;
  const pageSize = parseInt(req.query?.pageSize, 10) || 20;
  const result = await fleetRepo.listTrucksByUser(req.auth.userId, { page, pageSize });
  return sendSuccess(res, 200, {
    ...result,
    items: result.items.map(enrichTruck)
  });
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
    const truck = await fleetRepo.getTruckById(id);
    if (!truck) return sendError(res, 404, "Not found");
    if (!canMutateTruck(truck, req.auth)) {
      return sendForbidden(res, "You do not own this truck", FORBIDDEN_CODES.FORBIDDEN_OWNER);
    }
    if (isSuspended(truck.status)) {
      return sendError(res, 409, "Suspended trucks cannot be edited", null, "TRUCK_SUSPENDED");
    }

    const { engineNumber, truckType, capacity, licensePlate, truckCardFrontImage, truckCardBackImage } = req.body || {};
    if (truckCardFrontImage != null && !isAllowedImageUrl(truckCardFrontImage)) {
      return sendError(res, 400, "Invalid truckCardFrontImage URL", null, "INVALID_IMAGE_URL");
    }
    if (truckCardBackImage != null && !isAllowedImageUrl(truckCardBackImage)) {
      return sendError(res, 400, "Invalid truckCardBackImage URL", null, "INVALID_IMAGE_URL");
    }

    let nextPlate = truck.license_plate;
    let nextEngine = truck.engine_number;
    if (licensePlate != null) {
      const plateCheck = validateLicensePlate(licensePlate);
      if (!plateCheck.ok) return sendError(res, 400, plateCheck.message, null, "VALIDATION_ERROR");
      nextPlate = plateCheck.value;
    }
    if (engineNumber != null) {
      const engineCheck = validateEngineNumber(engineNumber);
      if (!engineCheck.ok) return sendError(res, 400, engineCheck.message, null, "VALIDATION_ERROR");
      nextEngine = engineCheck.value;
    }

    const dup = await fleetRepo.findDuplicate({
      licensePlate: nextPlate,
      engineNumber: nextEngine,
      chassisNumber: truck.chassis_number,
      excludeId: id
    });
    if (dup) {
      return sendError(res, 409, "A truck with this plate or engine number already exists", null, "TRUCK_EXISTS");
    }

    const identityChanged =
      (licensePlate != null && nextPlate !== truck.license_plate) ||
      (engineNumber != null && nextEngine !== truck.engine_number);
    const nextStatus =
      isApprovedForMatching(truck.status) && identityChanged ? TRUCK_STATUS.PENDING : truck.status;

    const uidStr = String(req.auth.userId);
    const { rows } = await query(
      `UPDATE trucks
       SET engine_number = COALESCE($2, engine_number),
           truck_type = COALESCE($3, truck_type),
           capacity = COALESCE($4, capacity),
           license_plate = COALESCE($5, license_plate),
           truck_card_front_image = COALESCE($6, truck_card_front_image),
           truck_card_back_image = COALESCE($7, truck_card_back_image),
           status = $8,
           updated_at = now()
       WHERE id = $1
       RETURNING id, engine_number AS "engineNumber", truck_type AS "truckType", capacity,
                 license_plate AS "licensePlate", chassis_number AS "chassisNumber",
                 status, is_default AS "isDefault",
                 truck_card_front_image AS "truckCardFrontImage",
                 truck_card_back_image AS "truckCardBackImage",
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        id,
        engineNumber != null ? nextEngine : null,
        truckType != null ? String(truckType).trim() : null,
        capacity != null ? Number(capacity || 0) : null,
        licensePlate != null ? nextPlate : null,
        truckCardFrontImage != null ? String(truckCardFrontImage).trim() : null,
        truckCardBackImage != null ? String(truckCardBackImage).trim() : null,
        nextStatus
      ]
    );
    const updated = rows[0];
    if (updated) {
      if (
        truckCardFrontImage != null &&
        truck.truck_card_front_image &&
        truck.truck_card_front_image !== updated.truckCardFrontImage
      ) {
        void safeDestroyReplacedUrl(uidStr, truck.truck_card_front_image, updated.truckCardFrontImage, "image");
      }
      if (
        truckCardBackImage != null &&
        truck.truck_card_back_image &&
        truck.truck_card_back_image !== updated.truckCardBackImage
      ) {
        void safeDestroyReplacedUrl(uidStr, truck.truck_card_back_image, updated.truckCardBackImage, "image");
      }
      await writeAudit({
        actorUserId: req.auth.userId,
        action: "truck.updated",
        targetEntity: "truck",
        targetId: id,
        metadata: { status: updated.status }
      });
      if (nextStatus === TRUCK_STATUS.PENDING && isApprovedForMatching(truck.status)) {
        await notifyUser({
          receiverId: req.auth.userId,
          senderId: req.auth.userId,
          roleType: "carrier",
          title: "TRUCK_UPDATED",
          message: "Truck details changed — pending admin re-approval"
        });
      }
    }
    return sendSuccess(res, 200, enrichTruck(updated));
  } catch (err) {
    if (String(err.code) === "23505") return sendError(res, 409, "Truck already exists", null, "TRUCK_EXISTS");
    return sendError(res, 500, err.message || "Server error", null, "SERVER_ERROR");
  }
}

async function setDefault(req, res) {
  const id = String(req.params.id);
  const truck = await fleetRepo.getTruckById(id);
  if (!truck) return sendError(res, 404, "Not found");
  if (!canMutateTruck(truck, req.auth)) {
    return sendForbidden(res, "You do not own this truck", FORBIDDEN_CODES.FORBIDDEN_OWNER);
  }
  if (!isApprovedForMatching(truck.status)) {
    return sendError(res, 409, "Only approved trucks can be set as default", null, "TRUCK_NOT_APPROVED");
  }
  const row = await fleetRepo.setDefaultTruck(req.auth.userId, id);
  if (!row) return sendError(res, 409, "Could not set default truck", null, "TRUCK_NOT_APPROVED");
  void writeAudit({
    actorUserId: req.auth.userId,
    action: "truck.default_set",
    targetEntity: "truck",
    targetId: id
  });
  return sendSuccess(res, 200, { ok: true, id: row.id });
}

async function remove(req, res) {
  const id = String(req.params.id);
  const truck = await fleetRepo.getTruckById(id);
  if (!truck) return sendError(res, 404, "Not found");
  if (!canMutateTruck(truck, req.auth)) {
    return sendForbidden(res, "You do not own this truck", FORBIDDEN_CODES.FORBIDDEN_OWNER);
  }

  const approvedCount = await fleetRepo.countApprovedTrucks(req.auth.userId);
  if (isApprovedForMatching(truck.status) && approvedCount <= 1) {
    return sendError(
      res,
      409,
      "Cannot remove your last approved truck — add another approved truck first",
      null,
      "LAST_APPROVED_TRUCK"
    );
  }

  await query(`DELETE FROM trucks WHERE id = $1 AND user_id = $2`, [id, req.auth.userId]);
  if (truck.is_default) {
    await fleetRepo.ensureDefaultTruck(req.auth.userId);
  }

  void writeAudit({
    actorUserId: req.auth.userId,
    action: "truck.deleted",
    targetEntity: "truck",
    targetId: id
  });
  return sendSuccess(res, 200, { ok: true });
}

module.exports = {
  validate,
  createValidators,
  updateValidators,
  create,
  mine,
  update,
  setDefault,
  remove
};
