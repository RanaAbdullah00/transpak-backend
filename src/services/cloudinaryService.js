const { cloudinary, ensureConfigured } = require("../../config/cloudinary");
const {
  UPLOAD_MEDIA_MAX_BYTES,
  UPLOAD_STREAM_TIMEOUT_MS,
  UPLOAD_MAX_RETRIES
} = require("../../config/uploadLimits");

function assertAllowedImageMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (!["image/jpeg", "image/png", "image/webp"].includes(m)) {
    throw Object.assign(new Error("Only JPG, PNG, or WebP images are allowed"), {
      statusCode: 400,
      code: "INVALID_MIME"
    });
  }
}

function assertAllowedPdfMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m !== "application/pdf") {
    throw Object.assign(new Error("Only PDF documents are allowed"), {
      statusCode: 400,
      code: "INVALID_MIME"
    });
  }
}

function assertBufferWithinLimit(buffer, maxBytes) {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw Object.assign(new Error("No file data"), { statusCode: 400, code: "NO_FILE" });
  }
  if (buffer.length === 0) {
    throw Object.assign(new Error("Empty file"), { statusCode: 400, code: "EMPTY_FILE" });
  }
  const max = Number(maxBytes) || UPLOAD_MEDIA_MAX_BYTES;
  if (buffer.length > max) {
    throw Object.assign(new Error("File too large"), { statusCode: 400, code: "FILE_TOO_LARGE" });
  }
}

function isRetryableUploadError(err) {
  if (!err) return false;
  const code = String(err.code || "").toUpperCase();
  if (["INVALID_MIME", "NO_FILE", "EMPTY_FILE", "FILE_TOO_LARGE"].includes(code)) return false;
  if (Number(err.statusCode) === 400 || Number(err.statusCode) === 403) return false;
  if (code === "UPLOAD_TIMEOUT" || code === "UPLOAD_STREAM_ERROR") return true;
  const http = err.http_code ?? err.cause?.http_code;
  if (http != null && Number(http) >= 500) return true;
  const netCodes = new Set(["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNABORTED"]);
  if (netCodes.has(err.code) || netCodes.has(err.cause?.code)) return true;
  if (Number(err.statusCode) === 503) return true;
  return false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function logUpload(level, ctx, fields) {
  const payload = {
    userId: ctx?.userId ?? null,
    route: ctx?.route ?? null,
    fileSize: fields?.fileSize ?? null,
    format: fields?.format ?? null,
    durationMs: fields?.durationMs ?? null,
    attempt: fields?.attempt ?? null,
    code: fields?.code ?? null,
    message: fields?.message ?? null
  };
  if (level === "error") {
    // eslint-disable-next-line no-console
    console.error("[cloudinary.upload]", payload);
  } else {
    // eslint-disable-next-line no-console
    console.log("[cloudinary.upload]", payload);
  }
}

function uploadBufferStreamOnce({ buffer, options, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stream = null;
    let timer = null;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (stream) {
        try {
          stream.removeAllListeners?.("error");
          if (typeof stream.destroy === "function") stream.destroy();
        } catch {
          /* ignore cleanup errors */
        }
        stream = null;
      }
      fn(value);
    };

    timer = setTimeout(() => {
      settle(reject, Object.assign(new Error("Upload timed out"), { statusCode: 503, code: "UPLOAD_TIMEOUT" }));
    }, timeoutMs);

    try {
      stream = cloudinary.uploader.upload_stream(options, (err, result) => {
        if (err) {
          settle(
            reject,
            Object.assign(new Error("File upload failed, please try again"), {
              statusCode: 503,
              code: "UPLOAD_FAILED",
              http_code: err.http_code,
              cause: err
            })
          );
          return;
        }
        if (!result?.secure_url) {
          settle(
            reject,
            Object.assign(new Error("Upload incomplete"), { statusCode: 503, code: "UPLOAD_INCOMPLETE" })
          );
          return;
        }
        settle(resolve, {
          url: result.secure_url,
          publicId: result.public_id,
          bytes: result.bytes,
          format: result.format,
          resourceType: result.resource_type || options.resource_type
        });
      });

      stream.on("error", (streamErr) => {
        settle(
          reject,
          Object.assign(new Error("Upload stream error"), {
            statusCode: 503,
            code: "UPLOAD_STREAM_ERROR",
            cause: streamErr
          })
        );
      });

      stream.end(buffer);
    } catch (syncErr) {
      settle(reject, syncErr);
    }
  });
}

async function uploadImageFile({ filePath, mimeType, folder, publicIdPrefix }) {
  try {
    ensureConfigured();
  } catch {
    throw Object.assign(new Error("File storage is not configured"), { statusCode: 503, code: "STORAGE_NOT_CONFIGURED" });
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
    console.error("[cloudinary.upload]", { message: err?.message, http_code: err?.http_code });
    throw Object.assign(new Error("File upload failed, please try again"), { statusCode: 503, code: "UPLOAD_FAILED" });
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
 * @param {{ buffer: Buffer, mimeType: string, folder?: string, resourceType?: string, publicIdPrefix?: string, maxBytes?: number, logContext?: { userId?: string, route?: string } }} params
 */
async function uploadBuffer({
  buffer,
  mimeType,
  folder = "transpak",
  resourceType = "image",
  publicIdPrefix,
  maxBytes = UPLOAD_MEDIA_MAX_BYTES,
  logContext = null
}) {
  try {
    ensureConfigured();
  } catch {
    throw Object.assign(new Error("File storage is not configured"), { statusCode: 503, code: "STORAGE_NOT_CONFIGURED" });
  }

  assertBufferWithinLimit(buffer, maxBytes);

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

  const timeoutMs = UPLOAD_STREAM_TIMEOUT_MS;
  const maxRetries = UPLOAD_MAX_RETRIES;
  const startedAt = Date.now();
  const fileSize = buffer.length;
  let lastErr = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const result = await uploadBufferStreamOnce({ buffer, options, timeoutMs });
      logUpload("info", logContext, {
        fileSize,
        format: result.format || m.split("/")[1] || null,
        durationMs: Date.now() - startedAt,
        attempt: attempt + 1,
        code: "OK"
      });
      return result;
    } catch (err) {
      lastErr = err;
      const retryable = isRetryableUploadError(err) && attempt < maxRetries;
      if (!retryable) break;
      // eslint-disable-next-line no-console
      console.warn("[cloudinary.upload] retry", {
        userId: logContext?.userId ?? null,
        attempt: attempt + 1,
        code: err.code || null,
        message: err.message
      });
      await sleep(400 * (attempt + 1));
    }
  }

  logUpload("error", logContext, {
    fileSize,
    format: m.split("/")[1] || null,
    durationMs: Date.now() - startedAt,
    code: lastErr?.code || "UPLOAD_FAILED",
    message: lastErr?.message
  });
  throw lastErr;
}

async function destroyByPublicId(publicId, resourceType = "image") {
  try {
    ensureConfigured();
  } catch {
    throw Object.assign(new Error("File storage is not configured"), { statusCode: 503, code: "STORAGE_NOT_CONFIGURED" });
  }
  const pid = String(publicId || "").trim();
  if (!pid) {
    throw Object.assign(new Error("publicId is required"), { statusCode: 400, code: "INVALID_PUBLIC_ID" });
  }
  try {
    const res = await cloudinary.uploader.destroy(pid, { resource_type: resourceType });
    return { result: res.result, publicId: pid };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[cloudinary.destroy]", err?.http_code || "", err?.message || err);
    throw Object.assign(new Error("Could not delete asset"), { statusCode: 503, code: "DELETE_FAILED" });
  }
}

module.exports = {
  uploadImageFile,
  uploadBuffer,
  destroyByPublicId,
  assertBufferWithinLimit
};
