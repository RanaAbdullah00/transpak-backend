const express = require("express");
const { body } = require("express-validator");
const { protect, requireAnyRole } = require("../middleware/authMiddleware");
const COMMERCIAL_ROLES = ["shipper", "carrier", "admin"];
const { uploadProfileImages } = require("../middleware/uploadProfileImages");
const { getProfile, updateProfile, getProfileStatus, getActivitySnapshot } = require("../controllers/profileController");
const { getPublicProfile } = require("../controllers/publicProfileController");
const { sendError } = require("../utils/apiResponse");

const router = express.Router();

function handleProfileUpload(req, res, next) {
  uploadProfileImages(req, res, (err) => {
    if (!err) return next();
    const msg = err.message || "File upload failed";
    if (err.code === "LIMIT_FILE_SIZE") {
      return sendError(res, 413, "File too large (max 5MB per image)");
    }
    return sendError(res, 400, msg);
  });
}

router.get("/", protect, requireAnyRole(COMMERCIAL_ROLES), getProfile);
router.get("/status", protect, requireAnyRole(COMMERCIAL_ROLES), getProfileStatus);
router.get("/activity-snapshot", protect, requireAnyRole(COMMERCIAL_ROLES), getActivitySnapshot);
router.get("/:id", protect, requireAnyRole(COMMERCIAL_ROLES), getPublicProfile);

router.put(
  "/update",
  protect,
  requireAnyRole(COMMERCIAL_ROLES),
  handleProfileUpload,
  [
    body("full_name")
      .optional({ values: "falsy" })
      .trim()
      .isLength({ min: 2, max: 120 })
      .withMessage("full_name must be 2-120 chars"),
    body("phone")
      .optional({ values: "falsy" })
      .trim()
      .custom((value) => {
        const raw = String(value ?? "").trim();
        const normalized = raw.startsWith("+") ? raw : `+${raw}`;
        if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
          throw new Error("Phone must be a valid international number");
        }
        return true;
      }),
    body("cnic_number")
      .optional({ values: "falsy" })
      .trim()
      .isLength({ min: 15, max: 15 })
      .withMessage("Invalid CNIC")
      .matches(/^[0-9]{5}-[0-9]{7}-[0-9]{1}$/)
      .withMessage("CNIC must be XXXXX-XXXXXXX-X")
  ],
  updateProfile
);

module.exports = router;

