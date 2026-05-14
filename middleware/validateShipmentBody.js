const { body, param, validationResult } = require("express-validator");
const { sendError } = require("../utils/apiResponse");

/** Shipment id in URL (in-memory key or safe token; blocks injection). */
const shipmentIdParam = [
  param("id")
    .trim()
    .notEmpty()
    .withMessage("Invalid shipment id")
    .matches(/^[a-zA-Z0-9._-]{1,72}$/)
    .withMessage("Invalid shipment id")
];

const shipmentStatusPutValidators = [
  body("status")
    .exists({ checkFalsy: true })
    .withMessage("Status is required")
    .isString()
    .trim()
    .isLength({ min: 1, max: 40 })
    .matches(/^[a-zA-Z0-9_\s-]+$/)
    .withMessage("Invalid status format")
];

function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const first = errors.array()[0];
  return sendError(res, 400, first.msg || "Validation error", {
    fields: errors.array().map((e) => e.path)
  });
}

module.exports = { shipmentIdParam, shipmentStatusPutValidators, handleValidationErrors };
