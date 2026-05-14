const path = require("path");
const multer = require("multer");

const uploadDir = path.join(__dirname, "..", "uploads");

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const safe = [".mp4", ".webm"].includes(ext) ? ext : ".mp4";
    cb(null, `official-demo${safe}`);
  }
});

function fileFilter(req, file, cb) {
  const ok = /^video\/(mp4|webm)$/i.test(file.mimetype || "");
  if (ok) return cb(null, true);
  cb(new Error("Only MP4 or WebM video is allowed"));
}

module.exports = multer({
  storage,
  fileFilter,
  limits: { fileSize: 52 * 1024 * 1024 }
});
