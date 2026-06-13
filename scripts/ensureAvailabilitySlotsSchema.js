/**
 * Apply migration 026 availability_slots — safe when column missing but migration row exists.
 * Usage: npm run db:ensure-availability-slots
 */
require("dotenv").config();
const { getPool, endPool } = require("../db/pool");
const { applyMigrationByName } = require("../db/migrate");
const { getSanitizedDatabaseInfo, formatSanitizedDatabaseLog } = require("../utils/dbSanitizedInfo");

async function columnExists(pool, table, column) {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

async function main() {
  const info = getSanitizedDatabaseInfo();
  console.log("[ensureAvailabilitySlotsSchema]", formatSanitizedDatabaseLog(info));

  const pool = getPool();
  await pool.query("SELECT 1");

  if (await columnExists(pool, "carrier_space_listings", "availability_slots")) {
    console.log("OK: carrier_space_listings.availability_slots already present");
    await endPool();
    return;
  }

  try {
    const result = await applyMigrationByName("026_carrier_space_availability_slots.sql");
    if (result.ok) {
      console.log("OK: applied 026_carrier_space_availability_slots.sql");
      await endPool();
      return;
    }
  } catch (err) {
    console.warn("[ensureAvailabilitySlotsSchema] applyMigrationByName:", err?.message || err);
  }

  await pool.query(
    `ALTER TABLE carrier_space_listings ADD COLUMN IF NOT EXISTS availability_slots jsonb DEFAULT NULL`
  );
  await pool.query(
    `INSERT INTO schema_migrations (name, executed_at) VALUES ($1, NOW()) ON CONFLICT (name) DO NOTHING`,
    ["026_carrier_space_availability_slots.sql"]
  );

  if (!(await columnExists(pool, "carrier_space_listings", "availability_slots"))) {
    console.error("FAILED: carrier_space_listings.availability_slots still missing");
    await endPool();
    process.exit(1);
  }

  console.log("OK: carrier_space_listings.availability_slots present (schema version 026)");
  await endPool();
}

main().catch(async (err) => {
  console.error(err?.message || err);
  await endPool().catch(() => {});
  process.exit(1);
});
