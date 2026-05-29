/**
 * Standard API envelope for TransPak backend.
 * Success: { success, message, data?, code? }
 * Error:   { success, message, data?, code?, errors?, deliveryReason?, deliveryHint? }
 */

const { clientMessage, sanitizeErrorData } = require("./safeApiError");

function sendSuccess(res, statusCode, data, message = "OK", code = null) {
  const payload = {
    success: true,
    message,
    data: data !== undefined ? data : null
  };
  if (code) payload.code = code;
  return res.status(statusCode || 200).json(payload);
}

/**
 * @param {import("express").Response} res
 * @param {number} statusCode
 * @param {string} message
 * @param {object|null} [data]
 * @param {string|null} [code]
 * @param {{ errors?: unknown, deliveryReason?: string, deliveryHint?: string }|null} [meta] — merged onto payload (not nested in data)
 */
function sendError(res, statusCode, message, data = null, code = null, meta = null) {
  const status = statusCode || 400;
  const resolvedCode =
    code ||
    (status >= 500 ? "SERVER_ERROR" : status === 404 ? "NOT_FOUND" : status === 403 ? "FORBIDDEN" : "ERROR");
  const payload = {
    success: false,
    code: resolvedCode,
    message: clientMessage(status, message),
    data: sanitizeErrorData(data),
    error: resolvedCode
  };
  if (meta && typeof meta === "object") {
    if (meta.errors !== undefined) payload.errors = meta.errors;
    if (meta.deliveryReason !== undefined) payload.deliveryReason = meta.deliveryReason;
    if (meta.deliveryHint !== undefined) payload.deliveryHint = meta.deliveryHint;
  }
  return res.status(statusCode || 400).json(payload);
}

module.exports = { sendSuccess, sendError };
