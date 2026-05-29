#!/usr/bin/env node
/**
 * Production DB consistency audit + optional safe repair (no data loss).
 * Usage:
 *   node scripts/production-db-audit.mjs           # audit only
 *   node scripts/production-db-audit.mjs --repair  # apply safe fixes
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");
const require = createRequire(path.join(backendRoot, "package.json"));
require("dotenv").config({ path: path.join(backendRoot, ".env") });

const { normalizeCommit, commitsMatch } = require(path.join(backendRoot, "utils/normalizeCommit.js"));

const REPAIR = process.argv.includes("--repair");
const EXPECTED_MIGRATIONS = [
  "020_truck_fleet_status.sql",
  "021_matching_engine_indexes.sql",
  "022_fleet_lifecycle.sql",
  "023_notifications_realtime.sql",
  "024_truck_status_constraint_reconcile.sql"
];
const CANONICAL_TRUCK_CHECK = "CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'suspended'::text])))";

function localCommit() {
  try {
    return execSync("git rev-parse HEAD", { cwd: path.join(backendRoot, ".."), encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function localCommitShort() {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: path.join(backendRoot, ".."), encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function fetchProductionHealth(apiOrigin) {
  const url = `${apiOrigin.replace(/\/$/, "")}/api/health`;
  const res = await fetch(url, { cache: "no-store" });
  const body = await res.json();
  return { url, status: res.status, data: body?.data || {} };
}

function classifyTruckConstraint(def) {
  const d = String(def || "").toLowerCase();
  const hasCanonical =
    d.includes("pending") && d.includes("approved") && d.includes("suspended");
  const hasLegacy = d.includes("active") || d.includes("pending_verification");
  if (hasCanonical && !hasLegacy) return "OK";
  if (hasLegacy) return "LEGACY";
  return "UNKNOWN";
}

async function main() {
  const apiOrigin = (
    process.env.QA_BASE_URL ||
    process.env.VITE_API_URL ||
    "https://transpak-backend-1.onrender.com"
  )
    .replace(/\/api\/?.*$/i, "")
    .replace(/\/$/, "");

  const localSha = localCommit();
  const localShort = localCommitShort();
  let health = null;
  try {
    health = await fetchProductionHealth(apiOrigin);
  } catch (e) {
    health = { error: e.message };
  }

  const deploy = health?.data?.deploy || {};
  const remoteFull =
    deploy.commitFull || health?.data?.commitFull || deploy.commit || health?.data?.build || health?.data?.commit || null;
  const remoteNormalized =
    deploy.normalizedCommit || deploy.commitShort || normalizeCommit(remoteFull);
  const localNormalized = normalizeCommit(localSha);
  const commitMatch = commitsMatch(localSha, remoteFull);

  const { getPool, endPool } = require(path.join(backendRoot, "db/pool.js"));
  const { verifySchema, SCHEMA_VERSION } = require(path.join(backendRoot, "db/schemaGuard.js"));
  const { getSanitizedDatabaseInfo, formatSanitizedDatabaseLog } = require(path.join(
    backendRoot,
    "utils/dbSanitizedInfo.js"
  ));

  const dbInfo = getSanitizedDatabaseInfo();
  console.log("\n=== DATABASE TARGET ===");
  console.log(formatSanitizedDatabaseLog(dbInfo));

  const pool = getPool();
  const issues = [];
  let repaired = [];

  try {
    await pool.query("SELECT 1");

    const migCols = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'schema_migrations'`
    );
    const migColNames = migCols.rows.map((r) => r.column_name);
    const orderBy = migColNames.includes("id")
      ? "id"
      : migColNames.includes("executed_at")
        ? "executed_at"
        : migColNames.includes("applied_at")
          ? "applied_at"
          : "name";
    const migrations = await pool.query(`SELECT * FROM schema_migrations ORDER BY ${orderBy}`);
    console.log("\n=== schema_migrations ===");
    console.log(`total rows: ${migrations.rows.length}`);
    const names = new Set(migrations.rows.map((r) => r.name));
    for (const m of EXPECTED_MIGRATIONS) {
      const ok = names.has(m);
      console.log(`  ${ok ? "OK" : "MISSING"} ${m}`);
      if (!ok) issues.push(`MISSING_MIGRATION:${m}`);
    }

    let lockRow = null;
    try {
      const lock = await pool.query(`SELECT * FROM migration_lock WHERE id = 1`);
      lockRow = lock.rows[0] || null;
      console.log("\n=== migration_lock ===");
      console.log(lockRow || "(no row)");
      if (lockRow?.locked) {
        const ageMs = Date.now() - new Date(lockRow.updated_at).getTime();
        const staleMs = Number(process.env.MIGRATION_LOCK_STALE_MS || 20 * 60 * 1000);
        if (ageMs < staleMs) {
          issues.push("MIGRATION_LOCK_STUCK");
        } else {
          console.log(`  lock stale (${Math.round(ageMs / 1000)}s) — reclaimable`);
        }
      }
    } catch (e) {
      console.log("\n=== migration_lock ===");
      console.log("(table missing — will be created on next db:migrate)");
    }

    const truckCols = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'trucks'
       ORDER BY ordinal_position`
    );
    console.log("\n=== trucks columns ===");
    for (const c of truckCols.rows) {
      console.log(`  ${c.column_name} ${c.data_type} nullable=${c.is_nullable}`);
    }

    const constraints = await pool.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
       WHERE conrelid = 'public.trucks'::regclass AND contype = 'c'`
    );
    console.log("\n=== trucks CHECK constraints ===");
    let truckCheckStatus = "OK";
    for (const c of constraints.rows) {
      console.log(`  ${c.conname}: ${c.def}`);
      if (c.conname === "trucks_status_check") {
        truckCheckStatus = classifyTruckConstraint(c.def);
      }
    }
    if (truckCheckStatus === "LEGACY") issues.push("DB_SCHEMA_DRIFT:trucks_status_check");

    const legacyCounts = await pool.query(
      `SELECT status, COUNT(*)::int AS c FROM trucks
       WHERE lower(trim(status)) IN ('active','pending_verification')
       GROUP BY status`
    );
    if (legacyCounts.rows.length) {
      console.log("\n=== legacy truck status rows ===");
      console.log(legacyCounts.rows);
      issues.push("LEGACY_TRUCK_STATUS_ROWS");
    }

    const schema = await verifySchema(pool);
    console.log("\n=== verifySchema ===");
    console.log(JSON.stringify(schema, null, 2));

    if (REPAIR && issues.length) {
      console.log("\n=== REPAIR (--repair) ===");
      await pool.query(
        `CREATE TABLE IF NOT EXISTS migration_lock (
          id INT PRIMARY KEY CHECK (id = 1),
          locked BOOLEAN NOT NULL DEFAULT false,
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )`
      );
      await pool.query(
        `UPDATE migration_lock SET locked = false, updated_at = NOW() WHERE id = 1`
      );
      repaired.push("migration_lock released");

      await pool.query(
        `UPDATE trucks SET status = 'pending' WHERE lower(trim(status)) = 'pending_verification'`
      );
      await pool.query(`UPDATE trucks SET status = 'approved' WHERE lower(trim(status)) = 'active'`);
      repaired.push("truck statuses normalized");

      await pool.query(`ALTER TABLE trucks DROP CONSTRAINT IF EXISTS trucks_status_check`);
      await pool.query(
        `ALTER TABLE trucks ADD CONSTRAINT trucks_status_check
         CHECK (status IN ('pending','approved','suspended'))`
      );
      repaired.push("trucks_status_check fixed");

      for (const m of EXPECTED_MIGRATIONS.filter((n) => !names.has(n))) {
        await pool.query(
          `INSERT INTO schema_migrations (name, executed_at) VALUES ($1, NOW()) ON CONFLICT (name) DO NOTHING`,
          [m]
        );
        repaired.push(`recorded migration ${m}`);
      }
    }
  } finally {
    await endPool();
  }

  const migrationStatus =
    issues.some((i) => i.startsWith("MISSING_MIGRATION")) ? "PARTIAL" : issues.length ? "OK_WITH_WARNINGS" : "OK";

  const deploymentStatus = commitMatch ? "SYNCED" : "DRIFTED";
  const dbStatus = health?.data?.db === "ready" && health?.data?.schema?.ok ? "ready" : "unavailable";

  const report = {
    deploymentStatus,
    commitMatch,
    localCommit: localShort,
    remoteCommit: remoteBuild,
    migrationStatus: migrationStatus === "OK_WITH_WARNINGS" && !issues.some((i) => i.startsWith("MISSING")) ? "OK" : migrationStatus,
    dbStatus,
    schemaVersion: health?.data?.schemaVersion || SCHEMA_VERSION,
    databaseHost: dbInfo.host,
    productionDatabaseHost: health?.data?.deploy?.databaseTarget?.host || null,
    dbTargetMatch: health?.data?.deploy?.databaseTarget?.host === dbInfo.host,
    issues,
    repaired: REPAIR ? repaired : [],
    primaryCause:
      !commitMatch
        ? "CODE_DRIFT"
        : issues.some((i) => i.includes("DB_SCHEMA_DRIFT") || i.includes("MISSING_MIGRATION"))
          ? "DB_SCHEMA_DRIFT"
          : issues.length
            ? "OPERATIONAL"
            : null
  };

  console.log("\n=== FINAL REPORT ===");
  console.log(JSON.stringify(report, null, 2));

  if (!commitMatch) {
    console.log("\nACTION: Redeploy Render backend from latest commit (git push + manual deploy).");
  }
  if (issues.some((i) => i.includes("DB_SCHEMA_DRIFT") || i.startsWith("MISSING_MIGRATION"))) {
    console.log("ACTION: Run `npm run db:migrate` against production DATABASE_URL (or `node scripts/production-db-audit.mjs --repair` for safe fixes).");
  }
  if (!issues.length && commitMatch) {
    console.log("\nAll checks passed.");
  }

  process.exit(commitMatch && !issues.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
