const { sendSuccess, sendError } = require("../utils/apiResponse");
const { normalizeRoutePayload } = require("../utils/routeResponse");
const ors = require("../services/openRouteService");

function routeSuccess(res, result) {
  return sendSuccess(res, 200, normalizeRoutePayload(result));
}

async function getRouteByCities(req, res) {
  const origin = String(req.query.origin || "").trim();
  const destination = String(req.query.destination || "").trim();
  if (!origin || !destination) {
    return sendError(res, 400, "origin and destination are required", null, "VALIDATION_ERROR");
  }

  const result = await ors.routeBetweenCities(origin, destination);
  if (!result.ok) {
    return sendError(res, 404, result.message || "Route not found", null, result.code || "NOT_FOUND");
  }

  return routeSuccess(res, result);
}

async function postRoute(req, res) {
  const { origin, destination, coordinates } = req.body || {};

  if (origin && destination) {
    const result = await ors.routeBetweenCities(
      String(origin).trim(),
      String(destination).trim()
    );
    if (!result.ok) {
      return sendError(res, 404, result.message || "Route not found", null, result.code || "NOT_FOUND");
    }
    return routeSuccess(res, result);
  }

  if (Array.isArray(coordinates)) {
    const result = await ors.routeBetweenPoints(coordinates);
    if (!result.ok) {
      return sendError(res, 400, result.message || "Invalid route", null, result.code || "VALIDATION_ERROR");
    }
    return routeSuccess(res, result);
  }

  return sendError(
    res,
    400,
    "Provide origin+destination or coordinates array",
    null,
    "VALIDATION_ERROR"
  );
}

module.exports = { getRouteByCities, postRoute };
