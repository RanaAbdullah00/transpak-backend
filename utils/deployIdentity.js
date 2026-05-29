/**
 * Deployment identity — build commit + schema guard version (no business logic).
 */
const { execSync } = require("child_process");
const path = require("path");
const { version: APP_VERSION } = require(path.join(__dirname, "..", "package.json"));
const { SCHEMA_VERSION } = require("../db/schemaGuard");
const { getSanitizedDatabaseInfo } = require("./dbSanitizedInfo");
const { normalizeCommit } = require("./normalizeCommit");

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
    schemaGuardVersion: SCHEMA_VERSION,
    expectedSchemaVersion: SCHEMA_VERSION,
    liveHealth: true,
    migrationSafe: true,
    nodeEnv: process.env.NODE_ENV || "undefined",
    databaseTarget: getSanitizedDatabaseInfo()
  };
}

function logDeployIdentity() {
  const id = getDeployIdentity();
  // eslint-disable-next-line no-console
  console.log("[deploy] commit:", id.commitFull);
  // eslint-disable-next-line no-console
  console.log("[deploy] runtime identity", {
    commit: id.commit,
    commitFull: id.commitFull,
    appVersion: id.appVersion,
    schemaGuardVersion: id.schemaGuardVersion,
    expectedSchemaVersion: id.expectedSchemaVersion,
    liveHealth: id.liveHealth,
    migrationSafe: id.migrationSafe,
    database: id.databaseTarget?.configured
      ? `host=${id.databaseTarget.host} db=${id.databaseTarget.database} provider=${id.databaseTarget.provider}`
      : "DATABASE_URL not set"
  });
}

module.exports = {
  getDeployIdentity,
  getDeploymentStatus,
  logDeployIdentity,
  resolveGitCommitFull,
  normalizeCommit,
  BUILD_ID,
  BUILD_COMMIT
};
