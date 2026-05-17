const { sendSuccess, sendError } = require("../utils/apiResponse");
const { uploadBuffer, destroyByPublicId } = require("../src/services/cloudinaryService");
const { UPLOAD_IMAGE_MAX_BYTES, UPLOAD_PDF_MAX_BYTES } = require("../config/uploadLimits");
const { releaseMulterFile, releaseMulterFiles } = require("../utils/uploadMemory");

function userBaseFolder(userId, segment) {
  return `transpak/u/${userId}/${segment}`;
}

function assertOwnedPublicIdSync(userId, publicId) {
  const pid = String(publicId || "").trim();
  const prefix = `transpak/u/${userId}/`;
  if (!pid.startsWith(prefix)) {
    const e = new Error("Not allowed to modify this asset");
    e.statusCode = 403;
    throw e;
  }
}

function assertChatAttachmentFromUserUpload(userId, url, publicId) {
  const u = String(url || "").trim();
  if (!u.startsWith("https://res.cloudinary.com")) {
    const e = new Error("Invalid attachment URL");
    e.statusCode = 400;
    throw e;
  }
  const prefix = `/transpak/u/${userId}/`;
  if (!u.includes(prefix)) {
    const e = new Error("Attachment must be uploaded via your account");
    e.statusCode = 403;
    throw e;
  }
  assertOwnedPublicIdSync(userId, publicId);
}

function pickImageFromReq(req) {
  if (req.file) return req.file;
  const g = req.files;
  if (g?.file?.[0]) return g.file[0];
  if (g?.image?.[0]) return g.image[0];
  return null;
}

function pickSingleBuffer(req) {
  return req.file || null;
}

async function postImage(req, res) {
  const file = pickImageFromReq(req);
  try {
    if (!file?.buffer) return sendError(res, 400, "file is required (field: file or image)", null, "NO_FILE");
    const uid = req.auth.userId;
    const folder = userBaseFolder(uid, "images");
    const out = await uploadBuffer({
      buffer: file.buffer,
      mimeType: file.mimetype,
      folder,
      resourceType: "image",
      publicIdPrefix: `img`,
      maxBytes: UPLOAD_IMAGE_MAX_BYTES,
      logContext: { userId: uid, route: "POST /api/upload/image" }
    });
    return sendSuccess(
      res,
      201,
      { url: out.url, publicId: out.publicId, bytes: out.bytes, format: out.format, resourceType: "image" },
      "Uploaded"
    );
  } catch (e) {
    const code = Number(e?.statusCode) || 500;
    return sendError(res, code, e?.message || "Upload failed", null, e?.code || "UPLOAD_FAILED");
  } finally {
    releaseMulterFile(file);
    if (req.files) releaseMulterFiles(req.files);
  }
}

async function postMultiple(req, res) {
  const files = Array.isArray(req.files) ? req.files : [];
  try {
    if (!files.length) return sendError(res, 400, "files are required (field: files, max 6)", null, "NO_FILE");
    const uid = req.auth.userId;
    const folder = userBaseFolder(uid, "images");
    const results = [];
    for (const file of files) {
      if (!file.buffer) continue;
      // eslint-disable-next-line no-await-in-loop
      const out = await uploadBuffer({
        buffer: file.buffer,
        mimeType: file.mimetype,
        folder,
        resourceType: "image",
        publicIdPrefix: `img`,
        maxBytes: UPLOAD_IMAGE_MAX_BYTES,
        logContext: { userId: uid, route: "POST /api/upload/multiple" }
      });
      results.push({ url: out.url, publicId: out.publicId, bytes: out.bytes, format: out.format });
    }
    if (!results.length) return sendError(res, 400, "No valid files", null, "NO_FILE");
    return sendSuccess(res, 201, { items: results }, "Uploaded");
  } catch (e) {
    const code = Number(e?.statusCode) || 500;
    return sendError(res, code, e?.message || "Upload failed", null, e?.code || "UPLOAD_FAILED");
  } finally {
    releaseMulterFiles(files);
  }
}

async function postDocument(req, res) {
  const file = pickSingleBuffer(req);
  try {
    if (!file?.buffer) return sendError(res, 400, "file is required (field: file)", null, "NO_FILE");
    const uid = req.auth.userId;
    const folder = userBaseFolder(uid, "docs");
    const out = await uploadBuffer({
      buffer: file.buffer,
      mimeType: file.mimetype,
      folder,
      resourceType: "raw",
      publicIdPrefix: `doc`,
      maxBytes: UPLOAD_PDF_MAX_BYTES,
      logContext: { userId: uid, route: "POST /api/upload/document" }
    });
    return sendSuccess(
      res,
      201,
      {
        url: out.url,
        publicId: out.publicId,
        bytes: out.bytes,
        format: out.format,
        resourceType: "raw"
      },
      "Uploaded"
    );
  } catch (e) {
    const code = Number(e?.statusCode) || 500;
    return sendError(res, code, e?.message || "Upload failed", null, e?.code || "UPLOAD_FAILED");
  } finally {
    releaseMulterFile(file);
  }
}

async function deleteAsset(req, res) {
  try {
    const publicId = String(req.query?.publicId || req.body?.publicId || "").trim();
    const resourceType = req.query?.resourceType === "raw" || req.body?.resourceType === "raw" ? "raw" : "image";
    if (!publicId) return sendError(res, 400, "publicId is required");
    assertOwnedPublicIdSync(req.auth.userId, publicId);
    await destroyByPublicId(publicId, resourceType);
    return sendSuccess(res, 200, { publicId, deleted: true }, "OK");
  } catch (e) {
    const code = Number(e?.statusCode) || 500;
    // eslint-disable-next-line no-console
    console.error("[upload] deleteAsset", { statusCode: code, message: e?.message });
    return sendError(res, code, e?.message || "Delete failed", null, "UPLOAD_FAILED");
  }
}

module.exports = {
  postImage,
  postMultiple,
  postDocument,
  deleteAsset,
  userBaseFolder,
  assertOwnedPublicIdSync,
  assertChatAttachmentFromUserUpload
};
