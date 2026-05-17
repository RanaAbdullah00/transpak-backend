const path = require("path");
const fs = require("fs");
const multer = require("multer");

const MAX_BYTES = 5 * 1024 * 1024;

function safeExtFromMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m === "image/jpeg") return ".jpg";
  if (m === "image/png") return ".png";
  if (m === "image/webp") return ".webp";
  return null;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, "..", "uploads"));
  },
  filename: (req, file, cb) => {
    const ext = safeExtFromMime(file.mimetype) || path.extname(file.originalname || "").slice(0, 10);
    const ts = Date.now();
    const rand = Math.random().toString(16).slice(2);
    cb(null, `example_${ts}_${rand}${ext || ""}`);
  }
});

/**
 * Accepts one file, field name "image", writes to ./uploads then handler should
 * call cloudinaryService.uploadImageFile and delete the temp file (see exampleUploadController).
 * Disk temp file + cloudinaryService.uploadImageFile (cloudinary@2, memory/stream elsewhere).
 */
const uploadCloudinaryImageSingle = multer({
  storage,
  limits: { fileSize: MAX_BYTES },
  fileFilter: (req, file, cb) => {
    if (!safeExtFromMime(file.mimetype)) {
      return cb(Object.assign(new Error("Only JPG, PNG, or WebP images are allowed"), { statusCode: 400 }));
    }
    return cb(null, true);
  }
}).single("image");

function cleanupExampleTempFile(req) {
  const p = req.file?.path;
  if (!p) return;
  try {
    fs.unlinkSync(p);
  } catch {
    // ignore
  }
}

module.exports = {
  uploadCloudinaryImageSingle,
  cleanupExampleTempFile,
  MAX_BYTES
};
