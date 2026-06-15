#!/usr/bin/env node
require("dotenv").config();
const { getSanitizedDatabaseInfo } = require("../utils/dbSanitizedInfo");
const { query, endPool } = require("../db/pool");

async function main() {
  const info = getSanitizedDatabaseInfo();
  console.log("[probe-db]", JSON.stringify({
    host: info.host,
    database: info.database,
    port: info.port,
    provider: info.provider,
    configured: info.configured
  }));

  const u = await query("SELECT COUNT(*)::int AS c FROM users");
  const l = await query("SELECT COUNT(*)::int AS c FROM loads");
  const m = await query("SELECT name FROM schema_migrations ORDER BY name");
  console.log("[probe-db] users", u.rows[0].c, "loads", l.rows[0].c);
  console.log("[probe-db] migrations", m.rows.map((r) => r.name));

  const cols028 = await query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'shipment_event_log'
       AND column_name IN ('parent_event_id', 'causality_type')`
  );
  const cols029 = await query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'users' AND column_name = 'review_prompt_dismissed'`
  );
  const traceTable = await query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables WHERE table_name = 'trace_spans'
     ) AS ok`
  );
  console.log("[probe-db] 028 columns", cols028.rows.map((r) => r.column_name));
  console.log("[probe-db] 029 column", cols029.rows.map((r) => r.column_name));
  console.log("[probe-db] trace_spans table", traceTable.rows[0].ok);
}

main()
  .catch((e) => {
    console.error("[probe-db] error:", e.message);
    process.exit(1);
  })
  .finally(() => endPool().catch(() => {}));
