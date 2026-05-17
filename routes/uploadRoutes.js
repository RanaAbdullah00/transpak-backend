const express = require("express");
const { protect } = require("../middleware/authMiddleware");
const { uploadLimiter } = require("../middleware/apiRateLimit");
const { uploadImageSingle, uploadImageMultiple, uploadPdfSingle } = require("../middleware/upload");
const { uploadMediaSingle, handleUploadMediaError } = require("../middleware/uploadCloudinaryMedia");
const { asyncHandler } = require("../utils/asyncHandler");
const uploadController = require("../controllers/uploadController");
const mediaUploadController = require("../controllers/mediaUploadController");

const router = express.Router();

const imageFields = uploadImageSingle.fields([
  { name: "file", maxCount: 1 },
  { name: "image", maxCount: 1 }
]);

router.post(
  "/media",
  protect,
  uploadLimiter,
  uploadMediaSingle,
  handleUploadMediaError,
  asyncHandler(mediaUploadController.postMedia)
);

router.post("/image", protect, uploadLimiter, imageFields, uploadController.postImage);
router.post("/multiple", protect, uploadLimiter, uploadImageMultiple.array("files", 6), uploadController.postMultiple);
router.post("/document", protect, uploadLimiter, uploadPdfSingle.single("file"), uploadController.postDocument);
router.delete("/", protect, uploadLimiter, uploadController.deleteAsset);

module.exports = router;
