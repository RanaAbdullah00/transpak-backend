#!/usr/bin/env node
/**
 * CLI entry for npm run db:migrate — sole path that applies DDL migrations.
 */
require("dotenv").config();
const { getSanitizedDatabaseInfo, formatSanitizedDatabaseLog } = require("../utils/dbSanitizedInfo");
const { runMigrations, MigrationLockHeldError } = require("../db/migrate");
const { endPool } = require("../db/pool");

async function main() {
  const info = getSanitizedDatabaseInfo();
  console.log("[db:migrate]", formatSanitizedDatabaseLog(info));
  await runMigrations();
  await endPool();
  console.log("[db:migrate] done");
}

main().catch(async (err) => {
  if (err?.code === "MIGRATION_LOCK_HELD" || err instanceof MigrationLockHeldError) {
    console.log("[db:migrate] skipped — another migration runner holds the lock");
    await endPool().catch(() => {});
    if (process.env.NODE_ENV === "production") {
      console.error("[db:migrate] refusing to continue in production without migrations");
      process.exit(1);
    }
    process.exit(0);
  }
  console.error("[db:migrate] failed:", err?.message || err);
  await endPool().catch(() => {});
  process.exit(1);
});
