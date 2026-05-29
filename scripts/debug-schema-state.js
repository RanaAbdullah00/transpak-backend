#!/usr/bin/env node
/**
 * Debug live schema + migration tracking state.
 */
require("dotenv").config();
const { getPool, endPool } = require("../db/pool");
const { verifySchema } = require("../db/schemaGuard");
const { getSanitizedDatabaseInfo, formatSanitizedDatabaseLog } = require("../utils/dbSanitizedInfo");

async function main() {
  console.log("DB target:", formatSanitizedDatabaseLog(getSanitizedDatabaseInfo()));
  const pool = getPool();
  await pool.query("SELECT 1");

  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'notifications'
       AND column_name IN ('dedupe_key', 'event_id')
     ORDER BY column_name`
  );
  console.log("notifications columns:", cols.rows.map((r) => r.column_name));

  const mig = await pool.query(
    `SELECT * FROM schema_migrations
     WHERE name LIKE '%023%' OR name LIKE '%baseline%'
     ORDER BY 1
     LIMIT 10`
  );
  console.log("schema_migrations (023/baseline):", mig.rows);

  const migCols = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'schema_migrations'`
  );
  console.log("schema_migrations columns:", migCols.rows.map((r) => r.column_name));

  const allMig = await pool.query(`SELECT COUNT(*)::int AS c FROM schema_migrations`);
  console.log("schema_migrations total:", allMig.rows[0]?.c);

  const schema = await verifySchema(pool);
  console.log("verifySchema:", JSON.stringify(schema, null, 2));

  await endPool();
}

main().catch(async (e) => {
  console.error(e.message || e);
  await endPool().catch(() => {});
  process.exit(1);
});
