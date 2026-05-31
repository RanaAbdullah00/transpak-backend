/**
 * Apply migration 025 only — safe for Render Shell when capacity bridge column missing.
 * Usage: npm run db:ensure-capacity-bridge
 */
require("dotenv").config();
const { getPool, endPool } = require("../db/pool");
const { applyMigrationByName } = require("../db/migrate");
const { getSanitizedDatabaseInfo, formatSanitizedDatabaseLog } = require("../utils/dbSanitizedInfo");

async function main() {
  const info = getSanitizedDatabaseInfo();
  console.log("[ensureCapacityBridgeSchema]", formatSanitizedDatabaseLog(info));

  const pool = getPool();
  await pool.query("SELECT 1");

  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'carrier_space_requests' AND column_name = 'load_id'
     LIMIT 1`
  );
  if (rows.length) {
    console.log("OK: carrier_space_requests.load_id already present");
    await endPool();
    return;
  }

  const result = await applyMigrationByName("025_capacity_shipment_bridge.sql");

  if (!result.ok) {
    console.error("FAILED:", result.message);
    await endPool();
    process.exit(1);
  }

  console.log("OK: carrier_space_requests.load_id present (schema version 025)");
  await endPool();
}

main().catch(async (err) => {
  console.error(err?.message || err);
  await endPool().catch(() => {});
  process.exit(1);
});
