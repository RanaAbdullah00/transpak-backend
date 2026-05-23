/**
 * Demo / FYP admin account — disabled in production unless explicitly enabled.
 */

function isDemoAdminEnabled() {
  const flag = String(process.env.ENABLE_TRANSPAK_DEMO_ADMIN || "").trim().toLowerCase();
  if (flag === "true") return true;
  if (flag === "false") return false;
  return process.env.NODE_ENV !== "production";
}

function getDemoAdminEmail() {
  if (!isDemoAdminEnabled()) return "";
  const fromEnv = String(process.env.TRANSPAK_DEMO_ADMIN_EMAIL || "").trim().toLowerCase();
  if (fromEnv) return fromEnv;
  return "mrrajpoot.327@gmail.com";
}

function isDemoAdminEmail(email) {
  const demo = getDemoAdminEmail();
  if (!demo) return false;
  return String(email || "").trim().toLowerCase() === demo;
}

module.exports = {
  isDemoAdminEnabled,
  getDemoAdminEmail,
  isDemoAdminEmail
};
