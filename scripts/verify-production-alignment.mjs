#!/usr/bin/env node
/**
 * Verify production deployment alignment (code version + schema 023 + DB target).
 * Commit comparison uses normalized 12-char SHA — full vs short never false-fails.
 * CODE_DRIFT is WARNING only (exit 0). Fails only on broken DB/schema/migrations.
 *
 * Usage: node scripts/verify-production-alignment.mjs [apiOrigin]
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

const API_ORIGIN = (
  process.argv[2] ||
  process.env.QA_BASE_URL ||
  process.env.VITE_API_URL ||
  "https://transpak-backend-1.onrender.com"
)
  .replace(/\/api\/?.*$/i, "")
  .replace(/\/$/, "");

const EXPECTED_SCHEMA = "023";
const REQUIRED_MIGRATIONS = [
  "020_truck_fleet_status.sql",
  "021_matching_engine_indexes.sql",
  "022_fleet_lifecycle.sql",
  "023_notifications_realtime.sql",
  "024_truck_status_constraint_reconcile.sql"
];

function localCommitFull() {
  const backendDir = path.join(__dirname, "..");
  const monorepoRoot = path.join(__dirname, "..", "..");
  /** Render deploys github.com/.../transpak-backend — use nested repo HEAD when present. */
  for (const cwd of [backendDir, monorepoRoot]) {
    try {
      return execSync("git rev-parse HEAD", { cwd, encoding: "utf8" }).trim();
    } catch {
      /* try next */
    }
  }
  return "unknown";
}

function localCommitSource() {
  const backendDir = path.join(__dirname, "..");
  try {
    execSync("git rev-parse HEAD", { cwd: backendDir, stdio: "pipe" });
    return "transpak-backend (Render deploy repo)";
  } catch {
    return "monorepo root";
  }
}

function printSection(title) {
  console.log(`\n=== ${title} ===`);
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

function resolveRemoteCommitRefs(data, res) {
  const deploy = data.deploy || {};
  const full =
    deploy.commitFull ||
    data.commitFull ||
    deploy.commit ||
    data.build ||
    data.commit ||
    res.headers.get("X-TransPak-Build") ||
    "";
  const normalized =
    deploy.normalizedCommit ||
    deploy.commitShort ||
    data.build ||
    data.commit ||
    normalizeCommit(full);
  return { full: String(full).trim(), normalized };
}

async function auditDatabase(pool) {
  const issues = [];
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
  const migrations = await pool.query(`SELECT name FROM schema_migrations ORDER BY ${orderBy}`);
  const names = new Set(migrations.rows.map((r) => r.name));
  const missingMigrations = REQUIRED_MIGRATIONS.filter((m) => !names.has(m));

  let lockStuck = false;
  try {
    const lock = await pool.query(`SELECT locked, updated_at FROM migration_lock WHERE id = 1`);
    const row = lock.rows[0];
    if (row?.locked) {
      const ageMs = Date.now() - new Date(row.updated_at).getTime();
      const staleMs = Number(process.env.MIGRATION_LOCK_STALE_MS || 20 * 60 * 1000);
      if (ageMs < staleMs) lockStuck = true;
    }
  } catch {
    /* created on next migrate */
  }

  const truckCheck = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def
     FROM pg_constraint
     WHERE conrelid = 'public.trucks'::regclass AND conname = 'trucks_status_check'`
  );
  const truckConstraint = classifyTruckConstraint(truckCheck.rows[0]?.def);

  if (missingMigrations.length) {
    issues.push({ type: "DB_SCHEMA_DRIFT", detail: `Missing migrations: ${missingMigrations.join(", ")}` });
  }
  if (lockStuck) {
    issues.push({ type: "MIGRATION_LOCK_STUCK", detail: "migration_lock.locked=true" });
  }
  if (truckConstraint === "LEGACY") {
    issues.push({ type: "DB_SCHEMA_DRIFT", detail: "trucks_status_check uses legacy enum values" });
  }

  const legacyRows = await pool.query(
    `SELECT COUNT(*)::int AS c FROM trucks
     WHERE lower(trim(status)) IN ('active','pending_verification')`
  );
  if (legacyRows.rows[0]?.c > 0) {
    issues.push({
      type: "LEGACY_TRUCK_ROWS",
      detail: `${legacyRows.rows[0].c} rows use active/pending_verification`
    });
  }

  const migrationStatus =
    missingMigrations.length > 0 ? "PARTIAL" : issues.some((i) => i.type === "DB_SCHEMA_DRIFT") ? "PARTIAL" : "OK";

  return { migrationCount: migrations.rows.length, missingMigrations, migrationStatus, truckConstraint, lockStuck, issues };
}

async function main() {
  printSection("Phase 1 — Deployment verification");
  const localFull = localCommitFull();
  const localNormalized = normalizeCommit(localFull);
  console.log("Local git source:", localCommitSource());
  console.log("Local git source:", localCommitSource());
  console.log("Local git HEAD (full):", localFull);
  console.log("Local git HEAD (normalized):", localNormalized);

  printSection("Production /api/health");
  const url = `${API_ORIGIN}/api/health`;
  console.log("GET", url);
  const res = await fetch(url, { cache: "no-store" });
  const body = await res.json();
  console.log(JSON.stringify(body, null, 2));

  const data = body?.data || {};
  const remote = resolveRemoteCommitRefs(data, res);
  const remoteNormalized = remote.normalized || normalizeCommit(remote.full);
  const commitMatch = commitsMatch(localFull, remote.full) || localNormalized === remoteNormalized;

  console.log("Remote commit (full):", remote.full || "(none)");
  console.log("Remote commit (normalized):", remoteNormalized || "(none)");
  console.log("Commit match (normalized):", commitMatch);

  const warnings = [];
  const failures = [];
  const issues = [];

  if (!commitMatch && localNormalized !== "unknown" && remoteNormalized) {
    const driftDetail = `Commit mismatch (normalized): local=${localNormalized} remote=${remoteNormalized} (full: local=${localFull} remote=${remote.full})`;
    warnings.push({ type: "CODE_DRIFT", status: "WARNING", detail: driftDetail });
    issues.push({ type: "CODE_DRIFT", detail: "Commit mismatch (normalized comparison)" });
    console.log("\n*** CODE DRIFT (warning only) ***");
    console.log(driftDetail);
  }

  printSection("Phase 2 — Database consistency (local DATABASE_URL)");
  let dbAudit = { migrationStatus: "SKIPPED", issues: [] };
  let localDb = null;
  try {
    const { getSanitizedDatabaseInfo, formatSanitizedDatabaseLog } = require(path.join(
      backendRoot,
      "utils/dbSanitizedInfo.js"
    ));
    localDb = getSanitizedDatabaseInfo();
    console.log("Target:", formatSanitizedDatabaseLog(localDb));
    const { getPool, endPool } = require(path.join(backendRoot, "db/pool.js"));
    const pool = getPool();
    dbAudit = await auditDatabase(pool);
    console.log("Migrations 020–024:", dbAudit.migrationStatus);
    console.log("trucks_status_check:", dbAudit.truckConstraint);
    await endPool();
  } catch (e) {
    console.log("DB audit skipped:", e.message);
    failures.push({ type: "DB_CONNECT_FAILED", detail: e.message });
  }

  for (const i of dbAudit.issues) {
    failures.push(i);
    issues.push(i);
  }

  const hasSchema = data.schema != null;
  const schemaOk = data.schema?.ok === true;
  const schemaVer = data.schemaVersion || data.schema?.version || data.deploy?.schemaGuardVersion;
  const prodDbReady = data.db === "ready";
  const dbTargetMatch =
    !localDb?.host ||
    !data.deploy?.databaseTarget?.host ||
    localDb.host === data.deploy.databaseTarget.host;

  if (!hasSchema || data.dbPing === "skipped") {
    failures.push({
      type: "STALE_HEALTH_ENDPOINT",
      detail: "Production lacks live health/schema — redeploy backend"
    });
    issues.push(failures[failures.length - 1]);
  }
  if (!dbTargetMatch && localDb?.host) {
    failures.push({
      type: "DB_TARGET_MISMATCH",
      detail: `Render DB host "${data.deploy?.databaseTarget?.host}" != local "${localDb.host}"`
    });
    issues.push(failures[failures.length - 1]);
  }
  if (schemaOk === false) {
    failures.push({
      type: "DB_SCHEMA_MISSING",
      detail: `Missing: ${(data.schema?.missing || []).join(", ")}`
    });
    issues.push(failures[failures.length - 1]);
  }
  if (!prodDbReady && schemaOk !== false && !failures.some((f) => f.type === "STALE_HEALTH_ENDPOINT")) {
    failures.push({ type: "DB_NOT_READY", detail: `Production db="${data.db}"` });
    issues.push(failures[failures.length - 1]);
  }

  const deploymentStatus =
    commitMatch && failures.length === 0 && prodDbReady && schemaOk ? "SYNCED" : "DRIFTED";
  const migrationStatus =
    dbAudit.migrationStatus === "OK" && schemaOk !== false
      ? "OK"
      : failures.some((f) => f.type.includes("SCHEMA"))
        ? "PARTIAL"
        : dbAudit.migrationStatus;

  const overallStatus = failures.length ? "FAIL" : warnings.length ? "WARNING" : "OK";

  const report = {
    status: overallStatus,
    deploymentStatus,
    commitMatch,
    localCommit: localFull,
    localCommitNormalized: localNormalized,
    remoteCommit: remote.full || null,
    remoteCommitNormalized: remoteNormalized || null,
    migrationStatus,
    dbStatus: prodDbReady && schemaOk ? "ready" : "unavailable",
    schemaVersion: schemaVer || EXPECTED_SCHEMA,
    dbTargetMatch,
    productionHealth: {
      db: data.db,
      dbPing: data.dbPing,
      schemaOk,
      deploymentStatus: data.deploymentStatus,
      migrationSafe: data.deploy?.migrationSafe
    },
    issues: issues.map((i) => ({ type: i.type, detail: i.detail })),
    warnings: warnings.map((w) => ({ type: w.type, detail: w.detail })),
    failures: failures.map((f) => ({ type: f.type, detail: f.detail })),
    primaryCause: failures.length ? failures[0].type : !commitMatch ? "CODE_DRIFT" : null,
    recommendedActions: []
  };

  if (!commitMatch) {
    report.recommendedActions.push("git push && Render Manual Deploy (clear build cache) if normalized commits differ");
  }
  if (failures.some((f) => f.type.includes("SCHEMA") || f.type === "DB_NOT_READY")) {
    report.recommendedActions.push("npm run db:migrate on production DATABASE_URL");
  }

  printSection("Phase 6 — Final verification");
  console.log(JSON.stringify(report, null, 2));

  if (warnings.length) {
    for (const w of warnings) {
      console.log(`WARN [${w.type}] ${w.detail}`);
    }
  }

  if (failures.length) {
    for (const f of failures) {
      console.log(`FAIL [${f.type}] ${f.detail}`);
    }
    process.exit(1);
  }

  if (warnings.length) {
    console.log("\nPASS with warnings: DB and schema OK.");
    process.exit(0);
  }

  console.log("\nOK: Production fully aligned.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
