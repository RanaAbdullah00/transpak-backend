/**
 * Development-only auth relax flags.
 *
 * SECURITY: `isDevAuthRelaxEnabled()` is ALWAYS false when NODE_ENV === "production",
 * regardless of env vars (defense in depth). Reversible: unset DEV_MODE / DEV_AUTH_TEST_EMAILS.
 *
 * Auth-related persistence in this codebase (no DB-backed sessions — JWT only; no auth_logs table):
 * - users (accounts, password_hash, verified)
 * - pending_registrations (pre-verify signup payload + hashed OTP)
 * - email_otp_challenges (register_verify, password_reset)
 * - auth_otp_codes (generic /api/auth/send-otp flow)
 */

function isProductionRuntime() {
  return String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
}

/**
 * @returns {boolean} True when not production and DEV_MODE is exactly "true" (case-insensitive).
 */
function isDevAuthRelaxEnabled() {
  if (isProductionRuntime()) return false;
  return String(process.env.DEV_MODE || "").trim().toLowerCase() === "true";
}

/**
 * Comma-separated allowlist from DEV_AUTH_TEST_EMAILS. Only these emails get
 * password-bypass re-registration and aggressive OTP resets (see devAuthTestState).
 *
 * @returns {Set<string>}
 */
function getDevAuthTestEmailSet() {
  const raw = String(process.env.DEV_AUTH_TEST_EMAILS || "");
  const set = new Set();
  for (const part of raw.split(",")) {
    const em = String(part || "").trim().toLowerCase();
    if (em) set.add(em);
  }
  return set;
}

function isAllowlistedDevTestEmail(email) {
  if (!isDevAuthRelaxEnabled()) return false;
  const em = String(email || "").trim().toLowerCase();
  if (!em) return false;
  return getDevAuthTestEmailSet().has(em);
}

module.exports = {
  isProductionRuntime,
  isDevAuthRelaxEnabled,
  getDevAuthTestEmailSet,
  isAllowlistedDevTestEmail
};
