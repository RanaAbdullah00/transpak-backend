/**
 * Read-only schema verification — NEVER modifies the database.
 * Use `npm run db:migrate` (db/migrate.js) to apply pending migrations.
 */
const SCHEMA_VERSION = "026";

/** Required columns for current backend (Phase 6+ realtime notifications). */
const REQUIRED_COLUMNS = [
  {
    table: "notifications",
    column: "dedupe_key",
    migration: "023_notifications_realtime.sql",
    migrationVersion: "023"
  },
  {
    table: "notifications",
    column: "event_id",
    migration: "023_notifications_realtime.sql",
    migrationVersion: "023"
  },
  {
    table: "carrier_space_requests",
    column: "load_id",
    migration: "025_capacity_shipment_bridge.sql",
    migrationVersion: "025"
  },
  {
    table: "loads",
    column: "booking_reference",
    migration: "026_loads_booking_reference.sql",
    migrationVersion: "026"
  },
  {
    table: "carrier_space_listings",
    column: "availability_slots",
    migration: "026_carrier_space_availability_slots.sql",
    migrationVersion: "026"
  }
];

async function columnExists(pool, table, column) {
  const { rows } = await pool.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
       AND column_name = $2
     LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

async function tableExists(pool, table) {
  const { rows } = await pool.query(
    `SELECT 1
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1
     LIMIT 1`,
    [table]
  );
  return rows.length > 0;
}

async function findMissingColumns(pool) {
  const missing = [];
  for (const req of REQUIRED_COLUMNS) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await tableExists(pool, req.table))) {
      missing.push({ ...req, reason: "table_missing" });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const exists = await columnExists(pool, req.table, req.column);
    if (!exists) missing.push(req);
  }
  return missing;
}

/**
 * Read-only schema check — returns structured status, no DDL.
 * @returns {Promise<{ ok: boolean, version: string, missing: string[], requiredMigration: string|null, message: string|null }>}
 */
async function verifySchema(pool, { silent = false } = {}) {
  const missingCols = await findMissingColumns(pool);
  const missing = missingCols.map((m) => `${m.table}.${m.column}`);

  const requiredMigration =
    missingCols.length > 0
      ? [...new Set(missingCols.map((m) => m.migration))].join(", ")
      : null;

  const ok = missing.length === 0;
  const message = ok
    ? null
    : `DB MIGRATION REQUIRED: missing ${missing.join(", ")} — run: npm run db:migrate (migration ${requiredMigration || "023_notifications_realtime.sql"}, SQL version ${SCHEMA_VERSION})`;

  if (!silent) {
    if (ok) {
      // eslint-disable-next-line no-console
      console.log(`[db] schema verify OK (version ${SCHEMA_VERSION})`);
    } else {
      // eslint-disable-next-line no-console
      console.error("[db]", message);
    }
  }

  return {
    ok,
    version: SCHEMA_VERSION,
    schemaVersion: SCHEMA_VERSION,
    missing,
    requiredMigration,
    message
  };
}

module.exports = {
  SCHEMA_VERSION,
  REQUIRED_COLUMNS,
  columnExists,
  tableExists,
  findMissingColumns,
  verifySchema
};
