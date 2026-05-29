/**
 * Deployment identity — build + schema guard version (no business logic).
 */
const path = require("path");
const { version: APP_VERSION } = require(path.join(__dirname, "..", "package.json"));
const { SCHEMA_VERSION } = require("../db/schemaGuard");
const { getSanitizedDatabaseInfo } = require("./dbSanitizedInfo");

const BUILD_COMMIT = String(
  process.env.RENDER_GIT_COMMIT || process.env.BUILD_ID || "local"
).trim();
const BUILD_ID = BUILD_COMMIT.slice(0, 12);

function getDeployIdentity() {
  return {
    appVersion: APP_VERSION,
    commit: BUILD_ID,
    commitFull: BUILD_COMMIT,
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
  console.log("[deploy] runtime identity", {
    commit: id.commit,
    commitFull: id.commitFull,
    appVersion: id.appVersion,
    schemaGuardVersion: id.schemaGuardVersion,
    expectedSchemaVersion: id.expectedSchemaVersion,
    liveHealth: id.liveHealth,
    database: id.databaseTarget?.configured
      ? `host=${id.databaseTarget.host} db=${id.databaseTarget.database} provider=${id.databaseTarget.provider}`
      : "DATABASE_URL not set"
  });
}

module.exports = { getDeployIdentity, logDeployIdentity, BUILD_ID, BUILD_COMMIT };
