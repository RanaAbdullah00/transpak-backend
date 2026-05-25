const express = require("express");
const { protect, requireAnyRole } = require("../middleware/authMiddleware");
const { uploadLimiter } = require("../middleware/apiRateLimit");
const { uploadImageSingle, uploadImageMultiple, uploadPdfSingle } = require("../middleware/upload");
const { uploadMediaSingle, handleUploadMediaError } = require("../middleware/uploadCloudinaryMedia");
const { asyncHandler } = require("../utils/asyncHandler");
const uploadController = require("../controllers/uploadController");
const mediaUploadController = require("../controllers/mediaUploadController");

const router = express.Router();
const UPLOAD_ROLES = ["shipper", "carrier", "admin"];

const imageFields = uploadImageSingle.fields([
  { name: "file", maxCount: 1 },
  { name: "image", maxCount: 1 }
]);

router.post(
  "/media",
  protect,
  requireAnyRole(UPLOAD_ROLES),
  uploadLimiter,
  uploadMediaSingle,
  handleUploadMediaError,
  asyncHandler(mediaUploadController.postMedia)
);

router.post("/image", protect, requireAnyRole(UPLOAD_ROLES), uploadLimiter, imageFields, uploadController.postImage);
router.post("/multiple", protect, requireAnyRole(UPLOAD_ROLES), uploadLimiter, uploadImageMultiple.array("files", 6), uploadController.postMultiple);
router.post("/document", protect, requireAnyRole(UPLOAD_ROLES), uploadLimiter, uploadPdfSingle.single("file"), uploadController.postDocument);
router.delete("/", protect, requireAnyRole(UPLOAD_ROLES), uploadLimiter, uploadController.deleteAsset);

module.exports = router;
