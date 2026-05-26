const fs = require("fs");
const path = require("path");
const { getPool } = require("./pool");

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
  "018_query_performance_indexes.sql"
];

async function runMigrations() {
  const pool = getPool();
  const schemaPath = path.join(__dirname, "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  await pool.query(sql);

  const migDir = path.join(__dirname, "migrations");
  for (const name of INCREMENTAL_MIGRATIONS) {
    const filePath = path.join(migDir, name);
    if (!fs.existsSync(filePath)) continue;
    const migSql = fs.readFileSync(filePath, "utf8");
    // eslint-disable-next-line no-console
    console.log("[db] applying migration:", name);
    await pool.query(migSql);
  }
}

module.exports = { runMigrations };
