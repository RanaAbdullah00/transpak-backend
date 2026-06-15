const { param, query: qv, validationResult } = require("express-validator");
const { sendSuccess, sendError } = require("../../utils/apiResponse");
const { writeAudit } = require("../../utils/auditLog");
const { notifyUser } = require("../../utils/notifyEvent");
const { emitContractDispatch } = require("../../utils/eventContractRegistry");
const { newEventId } = require("../../utils/realtimeDispatch");
const {
  TRUCK_STATUS,
  hasRequiredDocuments,
  apiTruckStatus
} = require("../../utils/truckLifecycle");
const fleetRepo = require("../../utils/fleetRepo");
const { invalidateAdminDashboardCache } = require("../../utils/adminDashboardCache");

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  );
}

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendError(res, 400, errors.array()[0]?.msg || "Validation error");
  }
  return next();
}

const listValidators = [
  qv("status")
    .optional()
    .isIn([TRUCK_STATUS.PENDING, TRUCK_STATUS.APPROVED, TRUCK_STATUS.SUSPENDED])
    .withMessage("Invalid status"),
  qv("page").optional().isInt({ min: 1 }),
  qv("pageSize").optional().isInt({ min: 5, max: 100 })
];

async function list(req, res) {
  const status = String(req.query?.status || TRUCK_STATUS.PENDING).toLowerCase();
  const page = parseInt(req.query?.page, 10) || 1;
  const pageSize = parseInt(req.query?.pageSize, 10) || 25;
  const result = await fleetRepo.listTrucksAdmin({ status, page, pageSize });
  const items = result.items.map((t) => ({
    ...t,
    statusLabel: apiTruckStatus(t.status),
    documentsComplete: hasRequiredDocuments(t)
  }));
  return sendSuccess(res, 200, { ...result, items });
}

async function loadTruckForAdmin(truckId) {
  const truck = await fleetRepo.getTruckById(truckId);
  if (!truck) return { truck: null, error: { status: 404, message: "Not found", code: "NOT_FOUND" } };
  return { truck };
}

async function approve(req, res) {
  const truckId = String(req.params.id);
  const { truck, error } = await loadTruckForAdmin(truckId);
  if (error) return sendError(res, error.status, error.message, null, error.code);
  if (!hasRequiredDocuments(truck)) {
    return sendError(res, 400, "Truck documents incomplete — cannot approve", null, "DOCS_INCOMPLETE");
  }
  if (String(truck.status) === TRUCK_STATUS.APPROVED) {
    return sendSuccess(res, 200, { ok: true, statusLabel: "APPROVED" }, "Already approved");
  }

  const updated = await fleetRepo.updateTruckStatus(truckId, TRUCK_STATUS.APPROVED);
  const approvedCount = await fleetRepo.countApprovedTrucks(truck.user_id);
  if (approvedCount === 1) {
    await fleetRepo.setDefaultTruck(truck.user_id, truckId);
  } else {
    await fleetRepo.ensureDefaultTruck(truck.user_id);
  }

  void writeAudit({
    actorUserId: req.auth.userId,
    action: "admin.truck.approved",
    targetEntity: "truck",
    targetId: truckId,
    metadata: { carrierId: truck.user_id }
  });
  emitContractDispatch({
    eventId: newEventId(),
    type: "TRUCK_APPROVED",
    receiverId: truck.user_id,
    roleType: "carrier",
    entityType: "truck",
    entityId: truckId,
    payload: { truckId, status: TRUCK_STATUS.APPROVED }
  });
  void notifyUser({
    receiverId: truck.user_id,
    senderId: req.auth.userId,
    roleType: "carrier",
    title: "TRUCK_APPROVED",
    type: "TRUCK_APPROVED",
    message: "Your truck registration was approved — you can bid on matching loads"
  });
  invalidateAdminDashboardCache();
  return sendSuccess(res, 200, { ok: true, statusLabel: "APPROVED", id: updated?.id });
}

async function reject(req, res) {
  const truckId = String(req.params.id);
  const { truck, error } = await loadTruckForAdmin(truckId);
  if (error) return sendError(res, error.status, error.message, null, error.code);

  await fleetRepo.updateTruckStatus(truckId, TRUCK_STATUS.SUSPENDED);
  if (truck.is_default) {
    await fleetRepo.ensureDefaultTruck(truck.user_id);
  }

  void writeAudit({
    actorUserId: req.auth.userId,
    action: "admin.truck.rejected",
    targetEntity: "truck",
    targetId: truckId,
    metadata: { carrierId: truck.user_id, reason: String(req.body?.reason || "").slice(0, 200) }
  });
  emitContractDispatch({
    eventId: newEventId(),
    type: "TRUCK_REJECTED",
    receiverId: truck.user_id,
    roleType: "carrier",
    entityType: "truck",
    entityId: truckId,
    payload: { truckId, status: TRUCK_STATUS.SUSPENDED }
  });
  void notifyUser({
    receiverId: truck.user_id,
    senderId: req.auth.userId,
    roleType: "carrier",
    title: "TRUCK_REJECTED",
    type: "TRUCK_REJECTED",
    message: "Your truck registration was rejected — contact support or re-submit documents"
  });
  return sendSuccess(res, 200, { ok: true, statusLabel: "SUSPENDED" });
}

async function suspend(req, res) {
  const truckId = String(req.params.id);
  const { truck, error } = await loadTruckForAdmin(truckId);
  if (error) return sendError(res, error.status, error.message, null, error.code);

  await fleetRepo.updateTruckStatus(truckId, TRUCK_STATUS.SUSPENDED);
  if (truck.is_default) {
    await fleetRepo.ensureDefaultTruck(truck.user_id);
  }

  void writeAudit({
    actorUserId: req.auth.userId,
    action: "admin.truck.suspended",
    targetEntity: "truck",
    targetId: truckId,
    metadata: { carrierId: truck.user_id, reason: String(req.body?.reason || "").slice(0, 200) }
  });
  emitContractDispatch({
    eventId: newEventId(),
    type: "TRUCK_SUSPENDED",
    receiverId: truck.user_id,
    roleType: "carrier",
    entityType: "truck",
    entityId: truckId,
    payload: { truckId, status: TRUCK_STATUS.SUSPENDED }
  });
  void notifyUser({
    receiverId: truck.user_id,
    senderId: req.auth.userId,
    roleType: "carrier",
    title: "TRUCK_SUSPENDED",
    type: "TRUCK_SUSPENDED",
    message: "A truck in your fleet was suspended and removed from matching"
  });
  return sendSuccess(res, 200, { ok: true, statusLabel: "SUSPENDED" });
}

const idParam = [
  param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid truck id"); })()))
];

module.exports = {
  validate,
  listValidators,
  list,
  approve,
  reject,
  suspend,
  idParam
};
