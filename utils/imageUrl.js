/** Cloudinary / CDN image URLs must be HTTPS (no blob/data/http). */
function isAllowedImageUrl(value) {
  const s = String(value || "").trim();
  if (!s || s.length > 2048) return false;
  if (/^blob:/i.test(s)) return false;
  if (/^data:/i.test(s)) return false;
  if (/^http:\/\//i.test(s)) return false;
  return /^https:\/\//i.test(s);
}

module.exports = { isAllowedImageUrl };
