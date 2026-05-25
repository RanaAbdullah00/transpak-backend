/** True when this process runs on Render (or similar) — not a laptop dev session. */
function isHostedOnPaas() {
  const renderUrl = String(process.env.RENDER_EXTERNAL_URL || "");
  if (renderUrl.includes("onrender.com")) return true;
  if (String(process.env.RENDER_SERVICE_ID || "").trim()) return true;
  if (String(process.env.RAILWAY_ENVIRONMENT || "").trim()) return true;
  if (String(process.env.FLY_APP_NAME || "").trim()) return true;
  return false;
}

module.exports = { isHostedOnPaas };
