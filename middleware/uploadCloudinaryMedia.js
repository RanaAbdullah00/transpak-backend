const multer = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const { cloudinary, ensureConfigured } = require("../config/cloudinary");

const MAX_BYTES = Number(process.env.UPLOAD_MEDIA_MAX_BYTES || 25 * 1024 * 1024);
const UPLOAD_FOLDER = String(process.env.CLOUDINARY_MEDIA_FOLDER || "transpak/media").trim();

function createUploadMediaSingle() {
  ensureConfigured();
  const storage = new CloudinaryStorage({
    cloudinary,
    params: {
      folder: UPLOAD_FOLDER,
      resource_type: "auto",
      use_filename: true,
      unique_filename: true
    }
  });
  return multer({
    storage,
    limits: { fileSize: MAX_BYTES }
  }).single("file");
}

const uploadMediaSingle = createUploadMediaSingle();

function handleUploadMediaError(err, req, res, next) {
  if (!err) return next();
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({
      success: false,
      message: "File too large",
      code: "FILE_TOO_LARGE",
      data: null
    });
  }
  // eslint-disable-next-line no-console
  console.error("[upload/media]", err?.message || err);
  return res.status(503).json({
    success: false,
    message: err?.message || "Upload failed",
    code: "UPLOAD_FAILED",
    data: null
  });
}

module.exports = {
  uploadMediaSingle,
  handleUploadMediaError
};
