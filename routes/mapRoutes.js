const express = require("express");
const { protect } = require("../middleware/authMiddleware");
const { mapsRouteLimiter } = require("../middleware/apiRateLimit");
const { asyncHandler } = require("../utils/asyncHandler");
const { getRouteByCities, postRoute } = require("../controllers/mapRouteController");

const router = express.Router();

router.use(protect, mapsRouteLimiter);

router.get("/route", asyncHandler(getRouteByCities));
router.post("/route", asyncHandler(postRoute));

module.exports = router;
