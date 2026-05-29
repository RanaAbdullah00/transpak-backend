const express = require("express");
const { asyncHandler } = require("../utils/asyncHandler");
const adminFleet = require("../src/controllers/adminFleetController");

const router = express.Router();

router.get("/trucks", adminFleet.listValidators, adminFleet.validate, asyncHandler(adminFleet.list));
router.patch(
  "/trucks/:id/approve",
  adminFleet.idParam,
  adminFleet.validate,
  asyncHandler(adminFleet.approve)
);
router.patch(
  "/trucks/:id/reject",
  adminFleet.idParam,
  adminFleet.validate,
  asyncHandler(adminFleet.reject)
);
router.patch(
  "/trucks/:id/suspend",
  adminFleet.idParam,
  adminFleet.validate,
  asyncHandler(adminFleet.suspend)
);

module.exports = router;
