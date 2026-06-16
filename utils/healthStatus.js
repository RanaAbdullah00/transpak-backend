/**
 * Build /api/health database + schema payload (read-only, live checks).
 * Waits for DB bootstrap before returning final schema.ok (never ambiguous "pending").
 */
const { verifySchema, SCHEMA_VERSION } = require("../db/schemaGuard");
const { isDatabaseUrlConfigured, query, getPool } = require("../db/pool");
const { waitForDbInit, DEFAULT_HEALTH_WAIT_MS } = require("../config/dbBootstrap");

const CONNECTING_GRACE_SEC = Number(process.env.HEALTH_CONNECTING_GRACE_SEC || 90);

function normalizeSchema(schema, dbState = {}) {
  if (schema && typeof schema === "object") {
    return {
      ok: Boolean(schema.ok),
      version: schema.version || schema.schemaVersion || SCHEMA_VERSION,
      schemaVersion: schema.schemaVersion || schema.version || SCHEMA_VERSION,
      missing: Array.isArray(schema.missing) ? schema.missing : [],
      requiredMigration: schema.requiredMigration || null,
      message: schema.message || null,
      booting: Boolean(schema.booting),
      notificationDedupeConstraint: schema.notificationDedupeConstraint || null
    };
  }
  if (dbState.needsMigration && dbState.schema) {
    return normalizeSchema(dbState.schema, {});
  }
  return {
    ok: false,
    version: SCHEMA_VERSION,
    schemaVersion: SCHEMA_VERSION,
    missing: [],
    requiredMigration: null,
    message: null,
    booting: false
  };
}

function bootingHealth() {
  return {
    db: "connecting",
    dbPing: "pending",
    schema: {
      ok: false,
      version: SCHEMA_VERSION,
      schemaVersion: SCHEMA_VERSION,
      missing: [],
      requiredMigration: null,
      message: null,
      booting: true
    },
    dbReady: false,
    booting: true,
    healthPhase: "booting",
    migrationRequired: null,
    schemaVersion: SCHEMA_VERSION
  };
}

/**
 * @param {{ ready?: boolean, needsMigration?: boolean, schema?: object|null, initSettled?: boolean, _initPromise?: Promise<void>|null }} dbState
 * @param {number} uptimeSeconds
 * @param {{ waitMs?: number }} [opts]
 */
async function resolveDatabaseHealth(dbState = {}, uptimeSeconds = 0, opts = {}) {
  const waitMs = opts.waitMs ?? DEFAULT_HEALTH_WAIT_MS;

  if (dbState._initPromise) {
    const wait = await waitForDbInit(dbState, waitMs);
    if (wait.timedOut && !dbState.initSettled) {
      return bootingHealth();
    }
  } else if (!dbState.initSettled && !dbState.schema) {
    return bootingHealth();
  }

  let schema = normalizeSchema(dbState.schema, dbState);
  let dbPing = "skipped";
  let dbReady = Boolean(dbState.ready);

  if (isDatabaseUrlConfigured()) {
    try {
      await query("SELECT 1");
      dbPing = "ok";
      const liveSchema = normalizeSchema(
        await verifySchema(getPool(), { silent: true }),
        dbState
      );
      schema = liveSchema;
      dbReady = liveSchema.ok === true;
      if (dbState.initSettled) {
        dbState.schema = liveSchema;
        dbState.ready = dbReady;
        dbState.needsMigration = !dbReady;
      }
    } catch {
      dbPing = "error";
      if (dbState.schema) {
        schema = normalizeSchema(dbState.schema, dbState);
      }
      dbReady = false;
    }
  }

  let db;
  if (dbReady && dbPing === "ok" && schema.ok) {
    db = "ready";
  } else if (!dbState.initSettled) {
    return bootingHealth();
  } else if (dbPing !== "ok") {
    db = "unavailable";
  } else if (!schema.ok || dbState.needsMigration) {
    db = "unavailable";
  } else {
    db = "unavailable";
  }

  return {
    db,
    dbPing,
    schema: { ...schema, booting: false },
    notificationDedupeConstraint: schema.notificationDedupeConstraint || null,
    dbReady: db === "ready",
    booting: false,
    healthPhase: db === "ready" ? "ready" : db === "connecting" ? "booting" : "degraded",
    migrationRequired: schema.ok === false ? schema.requiredMigration || "023_notifications_realtime.sql" : null,
    schemaVersion: schema.version
  };
}

function resolveDistributedHealthForApi() {
  try {
    const { getDistributedHealthSnapshot } = require("./distributedBootstrapGuard");
    const { getDistributedModeSummary } = require("./distributedMode");
    const mode = getDistributedModeSummary();
    const snap = getDistributedHealthSnapshot();
    let redisMode = "memory";
    try {
      const { getRedisMode } = require("./redisClient");
      redisMode = getRedisMode();
    } catch {
      redisMode = "unavailable";
    }
    const ok = mode.requiresRedis ? snap.ok && redisMode === "redis" : true;
    return {
      strict: mode.strict,
      multiInstance: mode.multiInstance,
      requiresRedis: mode.requiresRedis,
      mode: redisMode,
      redis: snap.redis || redisMode === "redis",
      pubsub: snap.pubsub || false,
      sequenceLock: snap.sequenceLock || false,
      ok: mode.requiresRedis ? ok && redisMode === "redis" : true,
      reason: ok && redisMode === "redis"
        ? null
        : snap.reason || (mode.requiresRedis ? "redis_required" : null)
    };
  } catch (err) {
    const { requiresRedis } = require("./distributedMode");
    return {
      strict: String(process.env.ENABLE_STRICT_DISTRIBUTED || "").toLowerCase() === "true",
      multiInstance: requiresRedis(),
      requiresRedis: requiresRedis(),
      mode: "unknown",
      ok: !requiresRedis(),
      reason: err?.message || null
    };
  }
}

module.exports = {
  resolveDatabaseHealth,
  resolveDistributedHealthForApi,
  CONNECTING_GRACE_SEC,
  normalizeSchema,
  bootingHealth,
  DEFAULT_HEALTH_WAIT_MS
};
