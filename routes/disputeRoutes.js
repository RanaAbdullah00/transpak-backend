const express = require("express");
const { protect, requireAnyRole } = require("../middleware/authMiddleware");
const disputeController = require("../src/controllers/disputeController");

const router = express.Router();

router.post("/", protect, requireAnyRole(["shipper", "carrier", "admin"]), disputeController.create);
router.get("/mine", protect, requireAnyRole(["shipper", "carrier", "admin"]), disputeController.mine);

module.exports = router;
