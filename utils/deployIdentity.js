/**
 * Deployment identity — build commit + schema guard version (no business logic).
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { version: APP_VERSION } = require(path.join(__dirname, "..", "package.json"));
const { SCHEMA_VERSION } = require("../db/schemaGuard");
const { getSanitizedDatabaseInfo, formatSanitizedDatabaseLog } = require("./dbSanitizedInfo");
const { normalizeCommit } = require("./normalizeCommit");
const { getPublicFeatureFlags } = require("./featureFlags");

const STAMP_PATH = path.join(__dirname, "..", ".render-build-stamp.json");

function readBuildStamp() {
  try {
    const raw = fs.readFileSync(STAMP_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function resolveGitCommitFull() {
  const fromEnv = String(
    process.env.RENDER_GIT_COMMIT ||
      process.env.GIT_COMMIT ||
      process.env.BUILD_ID ||
      ""
  ).trim();
  if (fromEnv && fromEnv !== "local" && fromEnv !== "unknown") {
    return fromEnv;
  }

  const stamp = readBuildStamp();
  if (
    stamp?.commitFull &&
    stamp.commitFull !== "unknown" &&
    (!process.env.RENDER_GIT_COMMIT || stamp.commitFull === process.env.RENDER_GIT_COMMIT)
  ) {
    return stamp.commitFull;
  }

  try {
    return execSync("git rev-parse HEAD", {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return fromEnv || "unknown";
  }
}

const BUILD_COMMIT = resolveGitCommitFull();
const BUILD_ID = normalizeCommit(BUILD_COMMIT) || "unknown";
const BUILD_STAMP = readBuildStamp();

/**
 * Runtime deployment status for /api/health (never blocks server).
 * @param {{ dbReady?: boolean, schemaOk?: boolean }} [opts]
 */
function getDeploymentStatus(opts = {}) {
  const { dbReady = false, schemaOk = false } = opts;
  if (dbReady && schemaOk) return "OK";
  return "DRIFTED";
}

function getDeployIdentity() {
  const normalizedCommit = BUILD_ID;
  return {
    appVersion: APP_VERSION,
    commit: normalizedCommit,
    commitShort: normalizedCommit,
    commitFull: BUILD_COMMIT,
    normalizedCommit,
    builtAt: BUILD_STAMP?.builtAt || null,
    schemaGuardVersion: SCHEMA_VERSION,
    expectedSchemaVersion: SCHEMA_VERSION,
    liveHealth: true,
    migrationSafe: true,
    bootHealthWait: true,
    nodeEnv: process.env.NODE_ENV || "undefined",
    databaseTarget: getSanitizedDatabaseInfo(),
    render: Boolean(process.env.RENDER || process.env.RENDER_SERVICE_ID),
    featureFlags: getPublicFeatureFlags()
  };
}

function logDeployIdentity() {
  const id = getDeployIdentity();
  const dbLog = id.databaseTarget?.configured
    ? formatSanitizedDatabaseLog(id.databaseTarget)
    : "DATABASE_URL not set";
  const deployedAt = new Date().toISOString();

  // eslint-disable-next-line no-console
  console.log(`[deploy] commit=${id.commitFull}`);
  // eslint-disable-next-line no-console
  console.log(`[deploy] time=${deployedAt}`);
  // eslint-disable-next-line no-console
  console.log(`[deploy] schema=${id.schemaGuardVersion}`);
  // eslint-disable-next-line no-console
  console.log(`[deploy] db=${dbLog}`);
  if (BUILD_STAMP?.builtAt) {
    // eslint-disable-next-line no-console
    console.log(`[deploy] buildStamp=${BUILD_STAMP.builtAt} short=${BUILD_STAMP.commitShort}`);
  }
  // eslint-disable-next-line no-console
  console.log("[deploy] runtime identity", {
    commitShort: id.commitShort,
    commitFull: id.commitFull,
    normalizedCommit: id.normalizedCommit,
    appVersion: id.appVersion,
    schemaGuardVersion: id.schemaGuardVersion,
    liveHealth: id.liveHealth,
    migrationSafe: id.migrationSafe,
    bootHealthWait: id.bootHealthWait,
    render: id.render
  });

  const expected = String(process.env.EXPECTED_DEPLOY_COMMIT || "").trim();
  if (expected && normalizeCommit(expected) !== id.normalizedCommit) {
    // eslint-disable-next-line no-console
    console.warn(
      "[deploy] DEPLOYMENT DRIFT DETECTED: EXPECTED_DEPLOY_COMMIT",
      expected,
      "!= running",
      id.commitFull
    );
  }
}

module.exports = {
  getDeployIdentity,
  getDeploymentStatus,
  logDeployIdentity,
  resolveGitCommitFull,
  normalizeCommit,
  readBuildStamp,
  BUILD_ID,
  BUILD_COMMIT
};
