const { Pool } = require("pg");

/**
 * Postgres via DATABASE_URL only (Render + Supabase). PGHOST/PGPORT/PGUSER/PGPASSWORD are not used.
 */

function getDatabaseUrl() {
  return String(process.env.DATABASE_URL || "").trim();
}

function normalizeDatabaseUrlForNodePg(urlStr) {
  const raw = String(urlStr || "").trim();
  if (!raw) return raw;
  try {
    const u = new URL(raw);
    if (u.hostname.toLowerCase().includes("supabase.co") && u.searchParams.has("sslmode") && !u.searchParams.has("uselibpqcompat")) {
      u.searchParams.set("uselibpqcompat", "true");
    }
    return u.toString();
  } catch {
    return raw;
  }
}

function shouldUseSsl(connectionString) {
  if (process.env.PGSSL === "false") return false;
  if (process.env.PGSSL === "true" || process.env.DATABASE_SSL === "true") return true;
  const isProd = String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
  const s = String(connectionString || "").toLowerCase();
  if (isProd && getDatabaseUrl()) return true;
  return (
    s.includes("supabase.co") ||
    s.includes("pooler.supabase.com") ||
    s.includes("render.com") ||
    s.includes("dpg-") ||
    s.includes("railway.app") ||
    s.includes("neon.tech") ||
    s.includes("sslmode=require") ||
    s.includes("sslmode=verify-full")
  );
}

function buildPoolConfig() {
  const rawUrl = getDatabaseUrl();
  if (!rawUrl) {
    throw new Error(
      "[db] DATABASE_URL is required (Supabase Session pooler URI on Render). PGHOST/PGPORT are not used."
    );
  }
  const connectionString = normalizeDatabaseUrlForNodePg(rawUrl);
  const config = { connectionString };
  if (shouldUseSsl(connectionString)) {
    const strict = String(process.env.PGSSL_REJECT_UNAUTHORIZED || "").toLowerCase() === "true";
    config.ssl = { rejectUnauthorized: strict };
  }
  return config;
}

function getConnectionTimeoutMs() {
  const n = Number(process.env.PG_CONNECTION_TIMEOUT_MS);
  if (Number.isFinite(n) && n >= 1000 && n <= 120000) return n;
  const url = getDatabaseUrl().toLowerCase();
  if (url.includes("supabase.co") || url.includes("pooler.supabase.com") || url.includes("render.com") || url.includes("dpg-")) {
    return 30000;
  }
  return 10000;
}

let _pool = null;

function getPool() {
  if (_pool) return _pool;
  const config = buildPoolConfig();
  _pool = new Pool({
    ...config,
    connectionTimeoutMillis: getConnectionTimeoutMs(),
    idleTimeoutMillis: 10000,
    max: Number(process.env.PG_POOL_MAX || 10)
  });
  _pool.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("[db] pool error:", err?.message || err);
  });
  return _pool;
}

async function endPool() {
  if (!_pool) return;
  const p = _pool;
  _pool = null;
  p.removeAllListeners("error");
  try {
    await p.end();
  } catch {
    // ignore
  }
}

function isDatabaseUrlConfigured() {
  return Boolean(getDatabaseUrl());
}

async function query(text, params) {
  return getPool().query(text, params);
}

module.exports = {
  getPool,
  query,
  isDatabaseUrlConfigured,
  endPool
};
