/** Central upload size / timeout limits (env-overridable). */
const UPLOAD_MEDIA_MAX_BYTES = Number(process.env.UPLOAD_MEDIA_MAX_BYTES || 25 * 1024 * 1024);
const UPLOAD_IMAGE_MAX_BYTES = Number(process.env.UPLOAD_IMAGE_MAX_BYTES || 5 * 1024 * 1024);
const UPLOAD_PDF_MAX_BYTES = Number(process.env.UPLOAD_PDF_MAX_BYTES || 10 * 1024 * 1024);
const UPLOAD_STREAM_TIMEOUT_MS = Number(process.env.UPLOAD_STREAM_TIMEOUT_MS || 60_000);
const UPLOAD_MAX_RETRIES = Math.min(3, Math.max(0, Number(process.env.UPLOAD_MAX_RETRIES ?? 2)));

module.exports = {
  UPLOAD_MEDIA_MAX_BYTES,
  UPLOAD_IMAGE_MAX_BYTES,
  UPLOAD_PDF_MAX_BYTES,
  UPLOAD_STREAM_TIMEOUT_MS,
  UPLOAD_MAX_RETRIES
};
