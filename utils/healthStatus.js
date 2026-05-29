/**
 * Build /api/health database + schema payload (read-only, live checks).
 */
const { verifySchema, SCHEMA_VERSION } = require("../db/schemaGuard");
const { isDatabaseUrlConfigured, query } = require("../db/pool");

const CONNECTING_GRACE_SEC = Number(process.env.HEALTH_CONNECTING_GRACE_SEC || 90);

function normalizeSchema(schema, dbState = {}) {
  if (schema && typeof schema === "object") {
    return {
      ok: Boolean(schema.ok),
      version: schema.version || schema.schemaVersion || SCHEMA_VERSION,
      schemaVersion: schema.schemaVersion || schema.version || SCHEMA_VERSION,
      missing: Array.isArray(schema.missing) ? schema.missing : [],
      requiredMigration: schema.requiredMigration || null,
      message: schema.message || null
    };
  }
  if (dbState.needsMigration) {
    return {
      ok: false,
      version: SCHEMA_VERSION,
      schemaVersion: SCHEMA_VERSION,
      missing: dbState.schema?.missing || [],
      requiredMigration: dbState.schema?.requiredMigration || "023_notifications_realtime.sql",
      message: dbState.schema?.message || "DB MIGRATION REQUIRED"
    };
  }
  return {
    ok: false,
    version: SCHEMA_VERSION,
    schemaVersion: SCHEMA_VERSION,
    missing: [],
    requiredMigration: null,
    message: null
  };
}

/**
 * @param {{ ready?: boolean, needsMigration?: boolean, schema?: object|null, error?: Error|null }} dbState
 * @param {number} uptimeSeconds
 */
async function resolveDatabaseHealth(dbState = {}, uptimeSeconds = 0) {
  let dbPing = "skipped";
  let schema = normalizeSchema(dbState.schema, dbState);
  let dbReady = Boolean(dbState.ready);

  if (isDatabaseUrlConfigured()) {
    try {
      await query("SELECT 1");
      dbPing = "ok";
      schema = normalizeSchema(await verifySchema(require("../db/pool").getPool(), { silent: true }), dbState);
      if (schema.ok) {
        dbReady = true;
      }
    } catch {
      dbPing = "error";
      if (dbState.schema) schema = normalizeSchema(dbState.schema, dbState);
    }
  }

  let db;
  if (dbReady && dbPing === "ok" && schema.ok) {
    db = "ready";
  } else if (dbPing !== "ok" && uptimeSeconds < CONNECTING_GRACE_SEC && !dbState.needsMigration) {
    db = "connecting";
  } else {
    db = "unavailable";
  }

  return {
    db,
    dbPing,
    schema,
    dbReady: db === "ready",
    migrationRequired: schema.ok === false ? schema.requiredMigration || "023_notifications_realtime.sql" : null,
    schemaVersion: schema.version
  };
}

module.exports = { resolveDatabaseHealth, CONNECTING_GRACE_SEC, normalizeSchema };
