const { getPool, endPool } = require("../db/pool");
const { runMigrations } = require("../db/migrate");

/**
 * Verifies DATABASE_URL connectivity and applies schema.sql (idempotent).
 * Logs are explicit for production debugging on Render + Supabase.
 * Errors are thrown to src/server.js connectWithRetry (HTTP server keeps running).
 */
async function connectDB() {
  // eslint-disable-next-line no-console
  console.log("[db] connecting...");
  try {
    const pool = getPool();
    await pool.query("SELECT 1");
    await runMigrations();
    // eslint-disable-next-line no-console
    console.log("[db] connected successfully");
    return pool;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[db] connection failed:", err?.message || String(err));
    await endPool().catch(() => {});
    throw err;
  }
}

module.exports = connectDB;
