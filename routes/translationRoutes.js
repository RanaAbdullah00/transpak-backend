const express = require("express");
const { protect } = require("../middleware/authMiddleware");
const { translationRuntimeLimiter } = require("../middleware/apiRateLimit");
const { runtimeTranslate } = require("../controllers/translationController");

const router = express.Router();

router.post("/runtime", protect, translationRuntimeLimiter, runtimeTranslate);

module.exports = router;
