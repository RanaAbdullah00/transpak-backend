/**
 * Extract Cloudinary public_id from a secure_url (video or image).
 */
function publicIdFromCloudinaryUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return null;
  const m = raw.match(/\/upload\/(?:[^/]+\/)*?(?:v\d+\/)?(.+?)(?:\.[a-zA-Z0-9]+)?(?:\?.*)?$/);
  if (!m) return null;
  return decodeURIComponent(m[1]);
}

module.exports = { publicIdFromCloudinaryUrl };
