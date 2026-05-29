/**
 * Apply migration 023 only — safe for Render Shell when notifications columns missing.
 * Usage: npm run db:ensure-notifications
 */
require("dotenv").config();
const { getPool, endPool } = require("../db/pool");
const { applyMigrationByName } = require("../db/migrate");
const { getSanitizedDatabaseInfo, formatSanitizedDatabaseLog } = require("../utils/dbSanitizedInfo");

async function main() {
  const info = getSanitizedDatabaseInfo();
  console.log("[ensureNotificationSchema]", formatSanitizedDatabaseLog(info));

  await getPool().query("SELECT 1");
  const result = await applyMigrationByName("023_notifications_realtime.sql");

  if (!result.ok) {
    console.error("FAILED:", result.message);
    await endPool();
    process.exit(1);
  }

  console.log("OK: notifications.dedupe_key and notifications.event_id present (schema version 023)");
  await endPool();
}

main().catch(async (err) => {
  console.error(err?.message || err);
  await endPool().catch(() => {});
  process.exit(1);
});
