const { sendSuccess, sendError } = require("../../utils/apiResponse");
const { query } = require("../../db/pool");
const { uploadVideoFile, destroyVideoByPublicId } = require("../services/videoCloudinaryService");
const { publicIdFromCloudinaryUrl } = require("../../utils/cloudinaryPublicId");
const { writeAudit } = require("../../utils/auditLog");

const ALLOWED_VIDEO_MIMES = new Set(["video/mp4", "video/webm", "video/quicktime"]);
const MAX_DEMO_VIDEO_BYTES = 50 * 1024 * 1024;

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
    if (!url) {
      return sendError(res, 404, "No demo video uploaded", null, "NOT_FOUND");
    }
    // Cloudinary serves video streaming efficiently; redirect client to the asset.
    return res.redirect(302, url);
  } catch (err) {
    return sendError(res, 500, err.message || "Stream error", null, "SERVER_ERROR");
  }
}

async function adminUpload(req, res) {
  try {
    if (!req.file) return sendError(res, 400, "No video file uploaded");
    const mime = String(req.file.mimetype || "").toLowerCase();
    if (!ALLOWED_VIDEO_MIMES.has(mime)) {
      return sendError(res, 400, "Only MP4, WebM, or MOV videos are allowed");
    }
    if (Number(req.file.size) > MAX_DEMO_VIDEO_BYTES) {
      return sendError(res, 400, "Video must be 50 MB or smaller");
    }

    const { rows: prior } = await query(
      `SELECT url FROM demo_video_meta ORDER BY created_at DESC LIMIT 5`
    );

    const uploaded = await uploadVideoFile({
      filePath: req.file.path,
      mimeType: req.file.mimetype,
      folder: "transpak/demo-videos",
      publicIdPrefix: "official_demo"
    });

    await query(`INSERT INTO demo_video_meta (url, mime_type) VALUES ($1, $2)`, [uploaded.url, mime || null]);

    for (const row of prior) {
      const oldId = publicIdFromCloudinaryUrl(row.url);
      if (oldId && oldId !== uploaded.publicId) {
        await destroyVideoByPublicId(oldId);
      }
    }

    void writeAudit({
      actorUserId: req.auth?.userId,
      action: "admin.demo_video.uploaded",
      targetEntity: "demo_video",
      targetId: uploaded.publicId || null,
      metadata: { url: uploaded.url, mimeType: mime }
    });
    return sendSuccess(res, 200, { ok: true, url: uploaded.url, mimeType: mime || null });
  } catch (err) {
    return sendError(res, err.statusCode || 500, err.message || "Upload failed", null, "UPLOAD_FAILED");
  } finally {
    try {
      require("fs").unlinkSync(req.file?.path);
    } catch {
      // ignore
    }
  }
}

module.exports = { getInfo, streamVideo, adminUpload };

