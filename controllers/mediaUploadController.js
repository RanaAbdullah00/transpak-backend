const { sendSuccess, sendError } = require("../utils/apiResponse");
const { uploadBuffer } = require("../src/services/cloudinaryService");
const { UPLOAD_MEDIA_MAX_BYTES } = require("../config/uploadLimits");
const { releaseMulterFile } = require("../utils/uploadMemory");

const UPLOAD_FOLDER = String(process.env.CLOUDINARY_MEDIA_FOLDER || "transpak/media").trim();

async function postMedia(req, res) {
  const file = req.file;
  try {
    if (!file?.buffer) {
      return sendError(res, 400, "No file uploaded. Use field name: file", null, "NO_FILE");
    }

    const uid = req.auth?.userId;
    const folder = uid ? `${UPLOAD_FOLDER}/u/${uid}` : UPLOAD_FOLDER;

    const out = await uploadBuffer({
      buffer: file.buffer,
      mimeType: file.mimetype,
      folder,
      resourceType: "image",
      publicIdPrefix: uid ? `media_${String(uid).slice(0, 8)}` : "media",
      maxBytes: UPLOAD_MEDIA_MAX_BYTES,
      logContext: { userId: uid || null, route: "POST /api/upload/media" }
    });

    return sendSuccess(
      res,
      200,
      {
        url: out.url,
        public_id: out.publicId,
        bytes: out.bytes ?? null,
        format: out.format ?? null
      },
      "Uploaded"
    );
  } catch (err) {
    const code = Number(err?.statusCode) && Number.isFinite(err.statusCode) ? err.statusCode : 503;
    const errCode = err?.code || "UPLOAD_FAILED";
    return sendError(res, code, err.message || "Upload failed", null, errCode);
  } finally {
    releaseMulterFile(file);
    if (req.file) releaseMulterFile(req.file);
  }
}

module.exports = { postMedia };
