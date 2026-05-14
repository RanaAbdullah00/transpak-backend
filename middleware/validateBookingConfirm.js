const { param, validationResult } = require("express-validator");
const { sendError } = require("../utils/apiResponse");
const { BOOKING_ERROR_CODES } = require("../utils/bookingErrors");

const validateBookingBidParam = [
  param("id")
    .trim()
    .notEmpty()
    .withMessage("Bid id is required")
    .isUUID()
    .withMessage("Bid id must be a valid UUID")
];

function validationErrorResponse(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return null;
  const first = errors.array({ onlyFirstError: true })[0];
  const msg = first?.msg || "Validation failed";
  return sendError(res, 400, msg, { field: first?.path || first?.param }, BOOKING_ERROR_CODES.BOOKING_VALIDATION_FAILED);
}

function bookingConfirmValidation(req, res, next) {
  const errRes = validationErrorResponse(req, res);
  if (errRes) return errRes;
  return next();
}

module.exports = {
  validateBookingBidParam,
  bookingConfirmValidation
};
