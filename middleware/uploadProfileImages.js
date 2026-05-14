const fs = require("fs");
const path = require("path");
const multer = require("multer");

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

const uploadsDir = path.join(__dirname, "..", "uploads");
try {
  fs.mkdirSync(uploadsDir, { recursive: true });
} catch {
  // ignore
}

function safeExtFromMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m === "image/jpeg") return ".jpg";
  if (m === "image/png") return ".png";
  if (m === "image/webp") return ".webp";
  return null;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const ext = safeExtFromMime(file.mimetype) || path.extname(file.originalname || "").slice(0, 10);
    const ts = Date.now();
    const rand = Math.random().toString(16).slice(2);
    cb(null, `profile_${ts}_${rand}${ext || ""}`);
  }
});

function fileFilter(req, file, cb) {
  const ext = safeExtFromMime(file.mimetype);
  if (!ext) return cb(new Error("Only JPG, PNG, or WebP images are allowed"));
  return cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE }
});

function cleanupUploadedFiles(req) {
  const filesByField = req.files || {};
  const list = [];
  Object.values(filesByField).forEach((arr) => {
    if (Array.isArray(arr)) {
      arr.forEach((f) => {
        if (f?.path) list.push(String(f.path));
      });
    }
  });
  for (const p of list) {
    try {
      // best-effort cleanup (Cloudinary is the source of truth)
      require("fs").unlinkSync(p);
    } catch {
      // ignore
    }
  }
}

module.exports = {
  uploadProfileImages: upload.fields([
    { name: "cnic_image", maxCount: 1 },
    { name: "cnic_image_back", maxCount: 1 },
    { name: "profile_image", maxCount: 1 }
  ]),
  cleanupUploadedFiles
};

