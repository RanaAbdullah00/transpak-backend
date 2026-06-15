/**
 * Paths exempt from the global DB-not-ready gate (relative to /api mount).
 * Public auth entry points must reach their controllers for controlled errors.
 */

const EXACT_EXEMPT = new Set([
  "/health",
  "/system/policy-health",
  "/auth/login",
  "/auth/register",
  "/auth/send-otp",
  "/auth/verify-otp",
  "/auth/resend-otp"
]);

function normalizeApiPath(path) {
  const p = String(path || "").split("?")[0].trim();
  if (!p) return "/";
  return p.startsWith("/") ? p : `/${p}`;
}

function isDbGateExemptPath(path) {
  const p = normalizeApiPath(path);
  if (EXACT_EXEMPT.has(p)) return true;
  if (p.startsWith("/public/")) return true;
  if (p.startsWith("/auth/otp/")) return true;
  return false;
}

module.exports = { isDbGateExemptPath, normalizeApiPath, EXACT_EXEMPT };
