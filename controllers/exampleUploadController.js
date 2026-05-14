const { sendSuccess, sendError } = require("../utils/apiResponse");
const { uploadImageFile } = require("../src/services/cloudinaryService");
const { cleanupExampleTempFile } = require("../middleware/uploadCloudinaryImage");

/**
 * Example: multipart field "image" → temp disk → Cloudinary → JSON URL.
 * Enable with ENABLE_EXAMPLE_UPLOAD=true (see src/app.js).
 */
async function postExampleImage(req, res) {
  if (!req.file?.path) return sendError(res, 400, "No image file (field name: image)");

  try {
    const uploaded = await uploadImageFile({
      filePath: req.file.path,
      mimeType: req.file.mimetype,
      folder: "transpak/example-uploads",
      publicIdPrefix: "example"
    });
    return sendSuccess(res, 200, {
      url: uploaded.url,
      publicId: uploaded.publicId,
      originalName: req.file.originalname || null,
      bytes: uploaded.bytes ?? null
    });
  } catch (err) {
    const status = err.statusCode || 500;
    return sendError(res, status, err.message || "Upload failed");
  } finally {
    cleanupExampleTempFile(req);
  }
}

module.exports = { postExampleImage };
