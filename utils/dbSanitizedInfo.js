/**
 * Sanitized DATABASE_URL info for startup logs (no credentials).
 */
function getSanitizedDatabaseInfo() {
  const raw = String(process.env.DATABASE_URL || "").trim();
  if (!raw) {
    return { configured: false, host: null, database: null, port: null, provider: null };
  }

  try {
    const u = new URL(raw);
    const host = u.hostname || null;
    const database = (u.pathname || "").replace(/^\//, "") || null;
    const port = u.port || "5432";
    const userPrefix = u.username ? String(u.username).slice(0, 12) : null;

    let provider = "postgres";
    if (host.includes("supabase")) provider = "supabase";
    else if (host.includes("render.com") || host.includes("dpg-")) provider = "render";
    else if (host.includes("neon.tech")) provider = "neon";
    else if (host.includes("railway")) provider = "railway";

    return {
      configured: true,
      host,
      database,
      port,
      provider,
      userPrefix: userPrefix ? `${userPrefix}…` : null,
      ssl: raw.toLowerCase().includes("sslmode=require") || process.env.NODE_ENV === "production"
    };
  } catch {
    return { configured: true, host: "(unparseable)", database: null, port: null, provider: "unknown" };
  }
}

function formatSanitizedDatabaseLog(info) {
  if (!info?.configured) return "DATABASE_URL not set";
  return `host=${info.host} db=${info.database || "?"} port=${info.port} provider=${info.provider || "?"}`;
}

module.exports = { getSanitizedDatabaseInfo, formatSanitizedDatabaseLog };
