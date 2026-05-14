const { destroyByPublicId } = require("../src/services/cloudinaryService");

/**
 * Extract Cloudinary public_id from a secure_url for cleanup/destroy.
 * @param {string} secureUrl
 * @returns {string|null}
 */
function tryParseCloudinaryPublicId(secureUrl) {
  const s = String(secureUrl || "").trim();
  if (!s.includes("res.cloudinary.com")) return null;
  try {
    const u = new URL(s);
    const parts = u.pathname.split("/").filter(Boolean);
    const uploadIdx = parts.indexOf("upload");
    if (uploadIdx === -1) return null;
    let i = uploadIdx + 1;
    if (parts[i] && /^v\d+$/i.test(parts[i])) i += 1;
    const rest = parts.slice(i).join("/");
    if (!rest) return null;
    const lastDot = rest.lastIndexOf(".");
    if (lastDot > 0 && rest.length - lastDot <= 5) {
      return rest.slice(0, lastDot);
    }
    return rest;
  } catch {
    return null;
  }
}

function canUserDestroyPublicId(userId, publicId) {
  const uid = String(userId || "");
  const pid = String(publicId || "");
  if (!uid || !pid) return false;
  if (pid.startsWith(`transpak/u/${uid}/`)) return true;
  if (pid.includes(uid)) return true;
  return false;
}

/**
 * Best-effort delete of a replaced Cloudinary asset (non-fatal on failure).
 * @param {string} userId
 * @param {string|null|undefined} previousUrl
 * @param {string|null|undefined} nextUrl
 * @param {'image'|'raw'} resourceType
 */
async function safeDestroyReplacedUrl(userId, previousUrl, nextUrl, resourceType = "image") {
  const prev = String(previousUrl || "").trim();
  const next = String(nextUrl || "").trim();
  if (!prev || prev === next || prev.startsWith("data:")) return;
  const pid = tryParseCloudinaryPublicId(prev);
  if (!pid || !canUserDestroyPublicId(userId, pid)) return;
  try {
    await destroyByPublicId(pid, resourceType);
  } catch {
    /* ignore */
  }
}

module.exports = {
  tryParseCloudinaryPublicId,
  canUserDestroyPublicId,
  safeDestroyReplacedUrl
};
