const { getPool } = require("../db/pool");
const { verifySchema, SCHEMA_VERSION } = require("../db/schemaGuard");
const { getSanitizedDatabaseInfo, formatSanitizedDatabaseLog } = require("../utils/dbSanitizedInfo");

let schemaWarningLogged = false;

/**
 * Connect + read-only schema verify — never runs migrations.
 * Server always starts; API uses dbState.ready / needsMigration for gating.
 * @param {{ ready?: boolean, needsMigration?: boolean, error?: Error|null, schema?: object|null }} [dbState]
 */
async function connectDB(dbState = null) {
  const dbInfo = getSanitizedDatabaseInfo();
  // eslint-disable-next-line no-console
  console.log("[db] connecting...", formatSanitizedDatabaseLog(dbInfo));

  const pool = getPool();

  try {
    await pool.query("SELECT 1");
  } catch (err) {
    if (dbState) {
      dbState.ready = false;
      dbState.needsMigration = false;
      dbState.error = err;
      dbState.schema = {
        ok: false,
        version: SCHEMA_VERSION,
        schemaVersion: SCHEMA_VERSION,
        missing: [],
        message: err.message || "Database connection failed"
      };
    }
    if (!schemaWarningLogged) {
      schemaWarningLogged = true;
      // eslint-disable-next-line no-console
      console.error("[db] DB NOT READY - RUN npm run db:migrate");
      // eslint-disable-next-line no-console
      console.error("[db] connection failed:", err?.message || String(err));
    }
    throw err;
  }

  let schema;
  try {
    schema = await verifySchema(pool);
  } catch (err) {
    schema = {
      ok: false,
      version: SCHEMA_VERSION,
      schemaVersion: SCHEMA_VERSION,
      missing: [],
      message: err.message || "Schema verification failed"
    };
  }

  if (dbState) {
    dbState.schema = schema;
    dbState.needsMigration = schema.ok === false;
    dbState.ready = schema.ok === true;
    dbState.error = schema.ok ? null : dbState.error || null;
  }

  if (schema.ok) {
    // eslint-disable-next-line no-console
    console.log("[db] connected successfully", `(schema version ${schema.version})`);
  } else if (!schemaWarningLogged) {
    schemaWarningLogged = true;
    // eslint-disable-next-line no-console
    console.error("[db] DB NOT READY - RUN npm run db:migrate");
    // eslint-disable-next-line no-console
    console.error("[db]", schema.message || "schema verification failed");
  }

  return pool;
}

module.exports = connectDB;
