const { cloudinary, ensureConfigured } = require("../../config/cloudinary");

function assertAllowedImageMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (!["image/jpeg", "image/png", "image/webp"].includes(m)) {
    throw Object.assign(new Error("Only JPG, PNG, or WebP images are allowed"), { statusCode: 400 });
  }
}

function assertAllowedPdfMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m !== "application/pdf") {
    throw Object.assign(new Error("Only PDF documents are allowed"), { statusCode: 400 });
  }
}

async function uploadImageFile({ filePath, mimeType, folder, publicIdPrefix }) {
  try {
    ensureConfigured();
  } catch {
    throw Object.assign(new Error("File storage is not configured"), { statusCode: 503 });
  }
  assertAllowedImageMime(mimeType);

  const options = {
    folder: folder || "transpak",
    resource_type: "image",
    use_filename: true,
    unique_filename: true
  };
  if (publicIdPrefix) options.public_id = `${publicIdPrefix}_${Date.now()}`;

  let result;
  try {
    result = await cloudinary.uploader.upload(filePath, options);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[cloudinary.upload]", err?.http_code || "", err?.message || err);
    throw Object.assign(new Error("File upload failed, please try again"), { statusCode: 503 });
  }
  return {
    url: result.secure_url,
    publicId: result.public_id,
    bytes: result.bytes,
    width: result.width,
    height: result.height,
    format: result.format
  };
}

/**
 * Upload from buffer (memory multer). folder should include tenant prefix, e.g. transpak/u/<userId>/img
 */
async function uploadBuffer({
  buffer,
  mimeType,
  folder = "transpak",
  resourceType = "image",
  publicIdPrefix
}) {
  try {
    ensureConfigured();
  } catch {
    throw Object.assign(new Error("File storage is not configured"), { statusCode: 503 });
  }

  const m = String(mimeType || "").toLowerCase();
  if (resourceType === "image" || resourceType === "auto") {
    assertAllowedImageMime(m);
  } else if (resourceType === "raw") {
    assertAllowedPdfMime(m);
  }

  const options = {
    folder: folder || "transpak",
    resource_type: resourceType,
    use_filename: true,
    unique_filename: true
  };
  if (publicIdPrefix) options.public_id = `${publicIdPrefix}_${Date.now()}`;

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
      if (err) {
        // eslint-disable-next-line no-console
        console.error("[cloudinary.upload_stream]", err?.http_code || "", err?.message || err);
        reject(Object.assign(new Error("File upload failed, please try again"), { statusCode: 503 }));
        return;
      }
      resolve({
        url: result.secure_url,
        publicId: result.public_id,
        bytes: result.bytes,
        format: result.format,
        resourceType: result.resource_type || resourceType
      });
    });
    stream.end(buffer);
  });
}

async function destroyByPublicId(publicId, resourceType = "image") {
  try {
    ensureConfigured();
  } catch {
    throw Object.assign(new Error("File storage is not configured"), { statusCode: 503 });
  }
  const pid = String(publicId || "").trim();
  if (!pid) {
    throw Object.assign(new Error("publicId is required"), { statusCode: 400 });
  }
  try {
    const res = await cloudinary.uploader.destroy(pid, { resource_type: resourceType });
    return { result: res.result, publicId: pid };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[cloudinary.destroy]", err?.http_code || "", err?.message || err);
    throw Object.assign(new Error("Could not delete asset"), { statusCode: 503 });
  }
}

module.exports = {
  uploadImageFile,
  uploadBuffer,
  destroyByPublicId
};
