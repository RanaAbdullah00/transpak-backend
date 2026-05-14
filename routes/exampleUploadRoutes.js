const express = require("express");
const { protect } = require("../middleware/authMiddleware");
const { uploadCloudinaryImageSingle } = require("../middleware/uploadCloudinaryImage");
const { postExampleImage } = require("../controllers/exampleUploadController");

const router = express.Router();

router.post("/image", protect, uploadCloudinaryImageSingle, postExampleImage);

module.exports = router;
