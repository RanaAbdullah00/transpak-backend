const { Pool } = require("pg");

function buildPgConfigFromEnv() {
  const url = String(process.env.DATABASE_URL || "").trim();
  if (url) {
    return {
      connectionString: url,
      ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined
    };
  }

  return {
    host: process.env.PGHOST || "127.0.0.1",
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || "transpak",
    user: process.env.PGUSER || "postgres",
    // Do not default a password: wrong defaults cause confusing "password authentication failed" when .env is missing/misread.
    password: process.env.PGPASSWORD,
    ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined
  };
}

let _pool = null;

function getPool() {
  if (_pool) return _pool;
  _pool = new Pool({
    ...buildPgConfigFromEnv(),
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 10000,
    max: 10
  });
  return _pool;
}

async function query(text, params) {
  const pool = getPool();
  return pool.query(text, params);
}

module.exports = {
  getPool,
  query
};

