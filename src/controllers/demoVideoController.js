const { sendSuccess, sendError } = require("../../utils/apiResponse");
const { query } = require("../../db/pool");
const { uploadVideoFile } = require("../services/videoCloudinaryService");

async function getInfo(req, res) {
  try {
    const { rows } = await query(`SELECT url, mime_type FROM demo_video_meta ORDER BY created_at DESC LIMIT 1`);
    const meta = rows[0] || null;
    return sendSuccess(res, 200, {
      hasVideo: Boolean(meta?.url),
      mimeType: meta?.mime_type || null,
      streamPath: "/api/demo-video/stream"
    });
  } catch (err) {
    return sendError(res, 500, err.message || "Server error");
  }
}

async function streamVideo(req, res) {
  try {
    const { rows } = await query(`SELECT url FROM demo_video_meta ORDER BY created_at DESC LIMIT 1`);
    const url = rows[0]?.url || null;
    if (!url) return res.status(404).json({ success: false, message: "No demo video uploaded", data: null });
    // Cloudinary serves video streaming efficiently; redirect client to the asset.
    return res.redirect(302, url);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Stream error", data: null });
  }
}

async function adminUpload(req, res) {
  try {
    if (!req.file) return sendError(res, 400, "No video file uploaded");

    const uploaded = await uploadVideoFile({
      filePath: req.file.path,
      mimeType: req.file.mimetype,
      folder: "transpak/demo-videos",
      publicIdPrefix: "official_demo"
    });

    await query(`INSERT INTO demo_video_meta (url, mime_type) VALUES ($1, $2)`, [uploaded.url, req.file.mimetype || null]);
    return sendSuccess(res, 200, { ok: true, url: uploaded.url, mimeType: req.file.mimetype || null });
  } catch (err) {
    return sendError(res, err.statusCode || 500, err.message || "Upload failed");
  } finally {
    try {
      require("fs").unlinkSync(req.file?.path);
    } catch {
      // ignore
    }
  }
}

module.exports = { getInfo, streamVideo, adminUpload };

