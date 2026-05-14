const { getPool } = require("../db/pool");
const { runMigrations } = require("../db/migrate");

async function connectDB() {
  const pool = getPool();
  await pool.query("SELECT 1");
  await runMigrations();
  return pool;
}

module.exports = connectDB;

