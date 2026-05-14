const multer = require("multer");

const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const PDF_MIMES = new Set(["application/pdf"]);

function imageFileFilter(req, file, cb) {
  const m = String(file.mimetype || "").toLowerCase();
  if (IMAGE_MIMES.has(m)) return cb(null, true);
  cb(new Error("Only JPG, PNG, or WebP images are allowed"));
}

function pdfFileFilter(req, file, cb) {
  const m = String(file.mimetype || "").toLowerCase();
  if (PDF_MIMES.has(m)) return cb(null, true);
  cb(new Error("Only PDF documents are allowed"));
}

const memory = multer.memoryStorage();

const uploadImageSingle = multer({
  storage: memory,
  limits: { fileSize: Number(process.env.UPLOAD_IMAGE_MAX_BYTES || 5 * 1024 * 1024) },
  fileFilter: imageFileFilter
});

const uploadImageMultiple = multer({
  storage: memory,
  limits: { fileSize: Number(process.env.UPLOAD_IMAGE_MAX_BYTES || 5 * 1024 * 1024) },
  fileFilter: imageFileFilter
});

const uploadPdfSingle = multer({
  storage: memory,
  limits: { fileSize: Number(process.env.UPLOAD_PDF_MAX_BYTES || 10 * 1024 * 1024) },
  fileFilter: pdfFileFilter
});

module.exports = {
  uploadImageSingle,
  uploadImageMultiple,
  uploadPdfSingle,
  IMAGE_MIMES,
  PDF_MIMES
};
