const { Pool } = require("pg");

/**
 * Enable TLS for common managed Postgres hosts when the URL implies SSL.
 * Set PGSSL=false to disable; PGSSL=true forces SSL. DATABASE_SSL=true also forces SSL.
 */
function buildSslOption(connectionString) {
  if (process.env.PGSSL === "false") return undefined;
  if (process.env.PGSSL === "true" || process.env.DATABASE_SSL === "true") {
    const strict = String(process.env.PGSSL_REJECT_UNAUTHORIZED || "").toLowerCase() === "true";
    return { rejectUnauthorized: strict };
  }
  const s = String(connectionString || "").toLowerCase();
  const inferred =
    s.includes("sslmode=require") ||
    s.includes("sslmode=verify-full") ||
    s.includes("render.com") ||
    s.includes("railway.app") ||
    s.includes("neon.tech") ||
    s.includes("supabase.co") ||
    s.includes("cockroachlabs.cloud") ||
    s.includes("amazonaws.com") ||
    s.includes("digitalocean.com");
  if (inferred) return { rejectUnauthorized: false };
  return undefined;
}

function buildPgConfigFromEnv() {
  const url = String(process.env.DATABASE_URL || "").trim();
  if (url) {
    return {
      connectionString: url,
      ssl: buildSslOption(url)
    };
  }

  return {
    host: process.env.PGHOST || "localhost",
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || "transpak",
    user: process.env.PGUSER || "postgres",
    password: process.env.PGPASSWORD,
    ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined
  };
}

function getConnectionTimeoutMs() {
  const n = Number(process.env.PG_CONNECTION_TIMEOUT_MS);
  if (Number.isFinite(n) && n >= 1000 && n <= 120000) return n;
  return 10000;
}

let _pool = null;

function getPool() {
  if (_pool) return _pool;
  _pool = new Pool({
    ...buildPgConfigFromEnv(),
    connectionTimeoutMillis: getConnectionTimeoutMs(),
    idleTimeoutMillis: 10000,
    max: 10
  });
  return _pool;
}

function isDatabaseUrlConfigured() {
  return Boolean(String(process.env.DATABASE_URL || "").trim());
}

async function query(text, params) {
  const pool = getPool();
  return pool.query(text, params);
}

module.exports = {
  getPool,
  query,
  isDatabaseUrlConfigured
};
