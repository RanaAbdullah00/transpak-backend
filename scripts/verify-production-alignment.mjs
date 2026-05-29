#!/usr/bin/env node
/**
 * Verify production deployment alignment (code version + schema 023 + DB target).
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

const API_ORIGIN = (
  process.argv[2] ||
  process.env.QA_BASE_URL ||
  process.env.VITE_API_URL ||
  "https://transpak-backend-1.onrender.com"
)
  .replace(/\/api\/?.*$/i, "")
  .replace(/\/$/, "");

const EXPECTED_SCHEMA = "023";

function localCommit() {
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: path.join(__dirname, "..", ".."),
      encoding: "utf8"
    }).trim();
  } catch {
    return "unknown";
  }
}

function printSection(title) {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  printSection("Local reference");
  const localSha = localCommit();
  console.log("git HEAD (short):", localSha);

  let localDb;
  try {
    const { getSanitizedDatabaseInfo, formatSanitizedDatabaseLog } = require(path.join(
      backendRoot,
      "utils/dbSanitizedInfo.js"
    ));
    localDb = getSanitizedDatabaseInfo();
    console.log("local DATABASE_URL target:", formatSanitizedDatabaseLog(localDb));
    const { getPool, endPool } = require(path.join(backendRoot, "db/pool.js"));
    const pool = getPool();
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='notifications'
         AND column_name IN ('dedupe_key','event_id')`
    );
    console.log("local notifications columns:", cols.rows.map((r) => r.column_name).join(", ") || "(none)");
    await endPool();
  } catch (e) {
    console.log("local DB check skipped:", e.message);
  }

  printSection("Production /api/health (raw)");
  const url = `${API_ORIGIN}/api/health`;
  console.log("GET", url);
  const res = await fetch(url, { cache: "no-store" });
  const body = await res.json();
  console.log(JSON.stringify(body, null, 2));

  const data = body?.data || {};
  const remoteBuild = data.build || data.commit || res.headers.get("X-TransPak-Build");
  const hasSchema = data.schema != null;
  const hasDeploy = data.deploy != null;
  const liveHealth = hasDeploy ? data.deploy.liveHealth : hasSchema;
  const dbStatus = data.db;
  const schemaOk = data.schema?.ok;
  const schemaVer = data.schemaVersion || data.schema?.version || data.deploy?.schemaGuardVersion;

  printSection("Diagnosis");
  const issues = [];

  if (remoteBuild && localSha !== "unknown" && !String(remoteBuild).startsWith(localSha) && remoteBuild !== localSha) {
    issues.push({
      type: "CODE_DRIFT",
      detail: `Render build "${remoteBuild}" != local HEAD "${localSha}" — redeploy backend from latest commit`
    });
  }

  if (!hasSchema || data.dbPing === "skipped") {
    issues.push({
      type: "STALE_HEALTH_ENDPOINT",
      detail: "Production lacks live health/schema fields — running pre-alignment build; redeploy required"
    });
  }

  if (hasDeploy && data.deploy?.databaseTarget?.host && localDb?.host) {
    if (data.deploy.databaseTarget.host !== localDb.host) {
      issues.push({
        type: "DB_TARGET_MISMATCH",
        detail: `Render DB host "${data.deploy.databaseTarget.host}" != local "${localDb.host}" — align Render DATABASE_URL`
      });
    }
  }

  if (schemaVer && schemaVer !== EXPECTED_SCHEMA) {
    issues.push({
      type: "SCHEMA_VERSION_MISMATCH",
      detail: `Expected schema ${EXPECTED_SCHEMA}, got ${schemaVer}`
    });
  }

  if (schemaOk === false) {
    issues.push({
      type: "DB_SCHEMA_MISSING",
      detail: `Missing: ${(data.schema?.missing || []).join(", ")} — run npm run db:migrate on Render`
    });
  }

  if (dbStatus !== "ready" && schemaOk !== false && !issues.some((i) => i.type === "STALE_HEALTH_ENDPOINT")) {
    issues.push({
      type: "DB_NOT_READY",
      detail: `db="${dbStatus}" dbPing="${data.dbPing}" — check Render DATABASE_URL and logs`
    });
  }

  if (!issues.length) {
    console.log("OK: Production aligned — db ready, schema version", schemaVer || EXPECTED_SCHEMA);
    process.exit(0);
  }

  for (const i of issues) {
    console.log(`FAIL [${i.type}] ${i.detail}`);
  }

  const codeDrift = issues.some((i) => i.type === "CODE_DRIFT" || i.type === "STALE_HEALTH_ENDPOINT");
  const dbMismatch = issues.some((i) => i.type === "DB_TARGET_MISMATCH" || i.type === "DB_SCHEMA_MISSING");
  console.log("\nPrimary cause:", codeDrift ? "CODE VERSION DRIFT (redeploy backend)" : dbMismatch ? "DATABASE MISMATCH (fix DATABASE_URL + migrate)" : "OPERATIONAL (check Render logs)");

  process.exit(1);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
