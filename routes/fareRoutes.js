const express = require("express");
const { body, validationResult } = require("express-validator");
const { protect } = require("../middleware/authMiddleware");
const { sendSuccess, sendError } = require("../utils/apiResponse");
const { estimateDistanceKm, calculateSuggestedFare } = require("../utils/loadFare");
const cities = require("../data/pakistanCities.json");

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendError(res, 400, errors.array()[0]?.msg || "Validation error");
  }
  return next();
}

router.get("/cities", protect, (req, res) => {
  const q = String(req.query?.q || "")
    .trim()
    .toLowerCase();
  let list = cities.map((c) => c.name);
  if (q) list = list.filter((name) => name.toLowerCase().includes(q));
  return sendSuccess(res, 200, list.slice(0, 80));
});

router.post(
  "/estimate",
  protect,
  [
    body("origin").trim().isLength({ min: 2, max: 120 }),
    body("destination").trim().isLength({ min: 2, max: 120 }),
    body("vehicleType").optional().trim().isLength({ max: 80 }),
    body("distanceKm").optional().toFloat().isFloat({ min: 0 })
  ],
  validate,
  (req, res) => {
    const { origin, destination, vehicleType, distanceKm } = req.body || {};
    const distance_km = estimateDistanceKm(origin, destination, distanceKm);
    const suggested_fare = calculateSuggestedFare(distance_km, vehicleType);
    return sendSuccess(res, 200, {
      origin: String(origin).trim(),
      destination: String(destination).trim(),
      distanceKm: distance_km,
      suggestedFare: suggested_fare,
      vehicleType: vehicleType || "Truck"
    });
  }
);

module.exports = router;
