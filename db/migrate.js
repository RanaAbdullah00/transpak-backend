const fs = require("fs");
const path = require("path");
const { getPool } = require("./pool");

async function runMigrations() {
  const pool = getPool();
  const schemaPath = path.join(__dirname, "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  await pool.query(sql);
}

module.exports = { runMigrations };

