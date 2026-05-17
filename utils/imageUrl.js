function isAllowedImageUrl(value) {
  const s = String(value || "").trim();
  if (!s || s.length > 2048) return false;
  if (/^data:/i.test(s)) return false;
  return /^https?:\/\//i.test(s);
}

module.exports = { isAllowedImageUrl };
