const express = require("express");
const { protect, requireAnyRole } = require("../middleware/authMiddleware");
const { translationRuntimeLimiter } = require("../middleware/apiRateLimit");
const { runtimeTranslate } = require("../controllers/translationController");

const router = express.Router();

router.post(
  "/runtime",
  protect,
  requireAnyRole(["shipper", "carrier", "admin"]),
  translationRuntimeLimiter,
  runtimeTranslate
);

module.exports = router;
