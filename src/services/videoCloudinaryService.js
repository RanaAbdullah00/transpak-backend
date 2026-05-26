const { cloudinary, ensureConfigured } = require("../../config/cloudinary");

function assertAllowedVideoMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (!["video/mp4", "video/webm", "video/quicktime"].includes(m)) {
    throw Object.assign(new Error("Only MP4, WebM, or MOV videos are allowed"), { statusCode: 400 });
  }
}

async function destroyVideoByPublicId(publicId) {
  if (!publicId) return;
  ensureConfigured();
  try {
    await cloudinary.uploader.destroy(String(publicId), { resource_type: "video", invalidate: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[cloudinary] destroy video skipped:", err?.message || err);
  }
}

async function uploadVideoFile({ filePath, mimeType, folder, publicIdPrefix }) {
  ensureConfigured();
  assertAllowedVideoMime(mimeType);

  const options = {
    folder: folder || "transpak",
    resource_type: "video",
    use_filename: true,
    unique_filename: true
  };
  if (publicIdPrefix) options.public_id = `${publicIdPrefix}_${Date.now()}`;

  const result = await cloudinary.uploader.upload(filePath, options);
  return {
    url: result.secure_url,
    publicId: result.public_id,
    bytes: result.bytes,
    format: result.format
  };
}

module.exports = {
  uploadVideoFile,
  destroyVideoByPublicId
};
