/**
 * Sole migration runner — invoked via `npm run db:migrate` only (never on npm start).
 * Each file runs at most once (schema_migrations). Concurrent runs blocked via migration_lock.
 */
const fs = require("fs");
const path = require("path");
const { getPool } = require("./pool");
const { verifySchema } = require("./schemaGuard");

const BASELINE_MIGRATION = "000_schema_baseline.sql";

const INCREMENTAL_MIGRATIONS = [
  "002_message_attachments.sql",
  "003_ensure_profile_and_bids.sql",
  "004_email_otp_challenges.sql",
  "005_auth_otp_codes.sql",
  "006_pending_registrations.sql",
  "007_load_fare_fields.sql",
  "008_carrier_space_listings.sql",
  "009_carrier_space_requests.sql",
  "010_space_request_lifecycle.sql",
  "011_ratings_space_request.sql",
  "012_carrier_load_dismissals.sql",
  "013_bid_lifecycle_status.sql",
  "014_bid_counter_round_count.sql",
  "015_load_deadline_minutes.sql",
  "016_load_route_and_location_log.sql",
  "017_audit_events.sql",
  "018_query_performance_indexes.sql",
  "019_truck_unique_constraints.sql",
  "020_truck_fleet_status.sql",
  "021_matching_engine_indexes.sql",
  "022_fleet_lifecycle.sql",
  "023_notifications_realtime.sql",
  "024_truck_status_constraint_reconcile.sql",
  "025_capacity_shipment_bridge.sql",
  "026_loads_booking_reference.sql",
  "026_carrier_space_availability_slots.sql"
];

const ALL_MIGRATIONS = [BASELINE_MIGRATION, ...INCREMENTAL_MIGRATIONS];

/** Reclaim lock if a previous runner crashed mid-migration (default 20 min). */
const STALE_LOCK_MS = Number(process.env.MIGRATION_LOCK_STALE_MS || 20 * 60 * 1000);

class MigrationLockHeldError extends Error {
  constructor() {
    super("[db] migration lock held by another runner — exiting without changes");
    this.name = "MigrationLockHeldError";
    this.code = "MIGRATION_LOCK_HELD";
  }
}

async function ensureMigrationLockTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS migration_lock (
      id INT PRIMARY KEY CHECK (id = 1),
      locked BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `INSERT INTO migration_lock (id, locked, updated_at) VALUES (1, false, NOW())
     ON CONFLICT (id) DO NOTHING`
  );
}

/**
 * Acquire exclusive migration lock (row-level FOR UPDATE).
 * @returns {Promise<boolean>}
 */
async function acquireMigrationLock(pool) {
  await ensureMigrationLockTable(pool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let { rows } = await client.query(
      `SELECT locked, updated_at FROM migration_lock WHERE id = 1 FOR UPDATE`
    );
    if (!rows.length) {
      await client.query(
        `INSERT INTO migration_lock (id, locked, updated_at) VALUES (1, false, NOW())`
      );
      ({ rows } = await client.query(
        `SELECT locked, updated_at FROM migration_lock WHERE id = 1 FOR UPDATE`
      ));
    }

    const row = rows[0];
    if (row.locked) {
      const ageMs = Date.now() - new Date(row.updated_at).getTime();
      if (ageMs < STALE_LOCK_MS) {
        await client.query("ROLLBACK");
        throw new MigrationLockHeldError();
      }
      // eslint-disable-next-line no-console
      console.warn("[db] migration lock stale — reclaiming", { ageMs });
    }

    await client.query(
      `UPDATE migration_lock SET locked = true, updated_at = NOW() WHERE id = 1`
    );
    await client.query("COMMIT");
    return true;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

async function releaseMigrationLock(pool) {
  await pool.query(
    `UPDATE migration_lock SET locked = false, updated_at = NOW() WHERE id = 1`
  );
}

async function ensureMigrationTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      executed_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS executed_at TIMESTAMP DEFAULT NOW()`).catch(() => {});
  await pool.query(`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ DEFAULT NOW()`).catch(() => {});
  await pool.query(
    `UPDATE schema_migrations SET executed_at = COALESCE(executed_at, applied_at, NOW()) WHERE executed_at IS NULL`
  ).catch(() => {});
}

async function isMigrationApplied(pool, name) {
  const { rows } = await pool.query(`SELECT 1 FROM schema_migrations WHERE name = $1 LIMIT 1`, [name]);
  return rows.length > 0;
}

async function markMigrationApplied(client, name) {
  await client.query(
    `INSERT INTO schema_migrations (name, executed_at) VALUES ($1, NOW()) ON CONFLICT (name) DO NOTHING`,
    [name]
  );
}

/**
 * Existing DBs before tracking: record all migrations without re-executing SQL.
 */
async function bootstrapExistingDatabaseRecords(pool) {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM schema_migrations`);
  if (rows[0]?.c > 0) return false;

  const { rows: usersTable } = await pool.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'users' LIMIT 1`
  );
  if (!usersTable.length) return false;

  const { rows: dedupeCol } = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'notifications' AND column_name = 'dedupe_key'
     LIMIT 1`
  );
  if (!dedupeCol.length) return false;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const name of ALL_MIGRATIONS) {
      // eslint-disable-next-line no-await-in-loop
      await markMigrationApplied(client, name);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // eslint-disable-next-line no-console
  console.log("[db] bootstrap: existing database — recorded migrations without re-execution");
  return true;
}

async function applyMigrationFile(pool, name, sql) {
  if (await isMigrationApplied(pool, name)) {
    // eslint-disable-next-line no-console
    console.log("[db] skip migration (already applied):", name);
    return false;
  }

  // eslint-disable-next-line no-console
  console.log("[db] applying migration:", name);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await markMigrationApplied(client, name);
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function runMigrationsInner(pool) {
  await ensureMigrationTable(pool);
  await bootstrapExistingDatabaseRecords(pool);

  const migDir = path.join(__dirname, "migrations");

  if (!(await isMigrationApplied(pool, BASELINE_MIGRATION))) {
    const schemaPath = path.join(__dirname, "schema.sql");
    const baselineSql = fs.readFileSync(schemaPath, "utf8");
    await applyMigrationFile(pool, BASELINE_MIGRATION, baselineSql);
  }

  for (const name of INCREMENTAL_MIGRATIONS) {
    const filePath = path.join(migDir, name);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Migration file not found: ${name}`);
    }
    const migSql = fs.readFileSync(filePath, "utf8");
    // eslint-disable-next-line no-await-in-loop
    await applyMigrationFile(pool, name, migSql);
  }

  const schema = await verifySchema(pool);
  if (!schema.ok) {
    const err = new Error(schema.message || "DB MIGRATION REQUIRED");
    err.code = "SCHEMA_MIGRATION_REQUIRED";
    err.schema = schema;
    throw err;
  }

  // eslint-disable-next-line no-console
  console.log("[db] all pending migrations applied — schema version", schema.version);
  return schema;
}

async function runMigrations() {
  const pool = getPool();
  let lockAcquired = false;
  try {
    await acquireMigrationLock(pool);
    lockAcquired = true;
    return await runMigrationsInner(pool);
  } finally {
    if (lockAcquired) {
      try {
        await releaseMigrationLock(pool);
      } catch (releaseErr) {
        // eslint-disable-next-line no-console
        console.error("[db] failed to release migration lock:", releaseErr?.message || releaseErr);
      }
    }
  }
}

async function applyMigrationByName(name) {
  const pool = getPool();
  let lockAcquired = false;
  try {
    await acquireMigrationLock(pool);
    lockAcquired = true;
    await ensureMigrationTable(pool);
    const filePath = path.join(__dirname, "migrations", name);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Migration not found: ${name}`);
    }
    const migSql = fs.readFileSync(filePath, "utf8");
    await applyMigrationFile(pool, name, migSql);
    return verifySchema(pool);
  } finally {
    if (lockAcquired) {
      await releaseMigrationLock(pool).catch(() => {});
    }
  }
}

module.exports = {
  runMigrations,
  applyMigrationByName,
  MigrationLockHeldError,
  INCREMENTAL_MIGRATIONS,
  ALL_MIGRATIONS,
  BASELINE_MIGRATION
};
