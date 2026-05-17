const multer = require("multer");
const { IMAGE_MIMES } = require("./upload");
const { UPLOAD_MEDIA_MAX_BYTES } = require("../config/uploadLimits");
const { sendError } = require("../utils/apiResponse");

function mediaFileFilter(req, file, cb) {
  const m = String(file.mimetype || "").toLowerCase();
  if (IMAGE_MIMES.has(m)) return cb(null, true);
  const err = new Error("Only JPG, PNG, or WebP images are allowed");
  err.statusCode = 400;
  err.code = "INVALID_MIME";
  cb(err);
}

/** Memory buffer upload — Cloudinary upload happens in mediaUploadController via upload_stream. */
const uploadMediaSingle = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_MEDIA_MAX_BYTES, files: 1 },
  fileFilter: mediaFileFilter
}).single("file");

function handleUploadMediaError(err, req, res, next) {
  if (!err) return next();
  if (err.code === "LIMIT_FILE_SIZE") {
    return sendError(res, 400, "File too large", null, "FILE_TOO_LARGE");
  }
  if (err.code === "INVALID_MIME" || err.statusCode === 400) {
    return sendError(res, 400, err.message || "Invalid file", null, err.code || "INVALID_MIME");
  }
  // eslint-disable-next-line no-console
  console.error("[upload/media]", err?.message || err);
  return sendError(res, 503, err?.message || "Upload failed", null, "UPLOAD_FAILED");
}

module.exports = {
  uploadMediaSingle,
  handleUploadMediaError,
  UPLOAD_MEDIA_MAX_BYTES
};
