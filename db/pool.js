const { Pool } = require("pg");

/**
 * TransPak uses a single env var for Postgres: DATABASE_URL.
 * PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD are not read (avoids split-brain config on Render).
 *
 * SSL (Supabase, Render, Neon, etc.):
 * - Default for managed hosts: ssl: { rejectUnauthorized: false } unless PGSSL_REJECT_UNAUTHORIZED=true
 * - PGSSL=false disables the ssl option (e.g. rare local TCP without TLS)
 */

function isProductionRuntime() {
  return String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
}

function getDatabaseUrl() {
  return String(process.env.DATABASE_URL || "").trim();
}

/**
 * Supabase dashboard URIs often include sslmode=… which triggers a Node pg deprecation warning.
 * Adding uselibpqcompat=true keeps current verify-full-like behaviour without changing Render env.
 * @see https://github.com/brianc/node-postgres/issues
 */
function normalizeDatabaseUrlForNodePg(urlStr) {
  const raw = String(urlStr || "").trim();
  if (!raw) return raw;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    if (!host.includes("supabase.co")) return raw;
    if (u.searchParams.has("sslmode") && !u.searchParams.has("uselibpqcompat")) {
      u.searchParams.set("uselibpqcompat", "true");
    }
    return u.toString();
  } catch {
    return raw;
  }
}

/**
 * @param {string} connectionString
 * @returns {object|undefined} pg `ssl` option; undefined = driver default (often no TLS for plain local)
 */
function buildSslOption(connectionString) {
  if (process.env.PGSSL === "false") return undefined;

  const strict = String(process.env.PGSSL_REJECT_UNAUTHORIZED || "").toLowerCase() === "true";
  if (process.env.PGSSL === "true" || process.env.DATABASE_SSL === "true") {
    return { rejectUnauthorized: strict };
  }

  const s = String(connectionString || "").toLowerCase();
  const managedTlsHint =
    isProductionRuntime() ||
    s.includes("sslmode=require") ||
    s.includes("sslmode=verify-full") ||
    s.includes("dpg-") ||
    s.includes("render.com") ||
    s.includes("railway.app") ||
    s.includes("neon.tech") ||
    s.includes("supabase.co") ||
    s.includes("pooler.supabase.com") ||
    s.includes("cockroachlabs.cloud") ||
    s.includes("amazonaws.com") ||
    s.includes("digitalocean.com");

  if (!managedTlsHint) return undefined;
  return { rejectUnauthorized: strict };
}

function buildPoolConfig() {
  const rawUrl = getDatabaseUrl();
  if (!rawUrl) {
    throw new Error(
      "[db] DATABASE_URL is required. Configure one Postgres URI (e.g. Supabase Session pooler or direct). PGHOST/PGPORT are not used."
    );
  }
  const connectionString = normalizeDatabaseUrlForNodePg(rawUrl);
  return {
    connectionString,
    ssl: buildSslOption(connectionString)
  };
}

function getConnectionTimeoutMs() {
  const n = Number(process.env.PG_CONNECTION_TIMEOUT_MS);
  if (Number.isFinite(n) && n >= 1000 && n <= 120000) return n;
  const url = getDatabaseUrl().toLowerCase();
  if (
    url.includes("render.com") ||
    url.includes("dpg-") ||
    url.includes("supabase.co") ||
    url.includes("pooler.supabase.com")
  ) {
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

/** Close pool so the next getPool() builds a fresh one (needed after auth failures / Supabase circuit breaker). */
async function endPool() {
  if (!_pool) return;
  const p = _pool;
  _pool = null;
  p.removeAllListeners("error");
  try {
    await p.end();
  } catch {
    // ignore shutdown races
  }
}

function isDatabaseUrlConfigured() {
  return Boolean(getDatabaseUrl());
}

async function query(text, params) {
  const pool = getPool();
  return pool.query(text, params);
}

module.exports = {
  getPool,
  query,
  isDatabaseUrlConfigured,
  endPool
};
