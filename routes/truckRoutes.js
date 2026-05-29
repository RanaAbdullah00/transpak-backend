const express = require("express");
const { protect, requireRole } = require("../middleware/authMiddleware");
const truckController = require("../src/controllers/truckController");

const router = express.Router();

router.post(
  "/",
  protect,
  requireRole("carrier"),
  truckController.createValidators,
  truckController.validate,
  truckController.create
);

router.get("/mine", protect, requireRole("carrier"), truckController.mine);

router.put(
  "/:id",
  protect,
  requireRole("carrier"),
  truckController.updateValidators,
  truckController.validate,
  truckController.update
);

router.patch(
  "/:id/default",
  protect,
  requireRole("carrier"),
  truckController.updateValidators.slice(0, 1),
  truckController.validate,
  truckController.setDefault
);

router.delete(
  "/:id",
  protect,
  requireRole("carrier"),
  truckController.updateValidators.slice(0, 1),
  truckController.validate,
  truckController.remove
);

module.exports = router;
