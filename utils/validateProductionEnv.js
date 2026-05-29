/**
 * Phase 8 — startup environment validation (warnings only; never exit in dev).
 */
function validateProductionEnv() {
  const isProd = process.env.NODE_ENV === "production";
  const issues = [];
  const warnings = [];

  if (!String(process.env.DATABASE_URL || "").trim()) {
    issues.push("DATABASE_URL is not set");
  }
  if (!String(process.env.JWT_SECRET || "").trim()) {
    issues.push("JWT_SECRET is not set");
  }
  if (isProd && String(process.env.JWT_SECRET || "").length < 32) {
    warnings.push("JWT_SECRET should be at least 32 characters in production");
  }

  const corsOrigins = [
    process.env.CORS_ORIGIN,
    process.env.FRONTEND_URL,
    process.env.VITE_APP_ORIGIN
  ].filter(Boolean);
  if (isProd && !corsOrigins.length) {
    warnings.push("Set CORS_ORIGIN or FRONTEND_URL for production browser access");
  }

  if (isProd && !String(process.env.CLOUDINARY_CLOUD_NAME || "").trim()) {
    warnings.push("Cloudinary env not set — media uploads may fail");
  }

  for (const msg of issues) {
    // eslint-disable-next-line no-console
    console.error(`[env] ${msg}`);
  }
  for (const msg of warnings) {
    // eslint-disable-next-line no-console
    console.warn(`[env] ${msg}`);
  }

  return { ok: issues.length === 0, issues, warnings };
}

module.exports = { validateProductionEnv };
