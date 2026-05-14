const { getPool } = require("../db/pool");
const { runMigrations } = require("../db/migrate");

async function connectDB() {
  const pool = getPool();
  await pool.query("SELECT 1");
  try {
    await runMigrations();
  } catch (err) {
    console.error("[db] runMigrations/schema.sql failed:", err?.code || "", err?.message || err);
    throw err;
  }
  return pool;
}

module.exports = connectDB;

