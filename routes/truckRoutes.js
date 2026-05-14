const express = require("express");
const { protect, requireAnyRole, requireActiveRole } = require("../middleware/authMiddleware");
const truckController = require("../src/controllers/truckController");

const router = express.Router();

router.post(
  "/",
  protect,
  requireAnyRole(["carrier", "admin"]),
  requireActiveRole("carrier"),
  truckController.createValidators,
  truckController.validate,
  truckController.create
);

router.get("/mine", protect, requireAnyRole(["carrier", "admin"]), requireActiveRole("carrier"), truckController.mine);

router.put(
  "/:id",
  protect,
  requireAnyRole(["carrier", "admin"]),
  requireActiveRole("carrier"),
  truckController.updateValidators,
  truckController.validate,
  truckController.update
);

module.exports = router;
