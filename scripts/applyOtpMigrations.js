/**
 * Applies OTP-related SQL migrations using the same DB config as the app.
 * Run from repo:  cd transpak-backend && node scripts/applyOtpMigrations.js
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const fs = require("fs");
const { getPool, endPool, isDatabaseUrlConfigured } = require("../db/pool");

const FILES = [
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
  "015_load_deadline_minutes.sql"
];

async function main() {
  if (!isDatabaseUrlConfigured()) {
    console.error("DATABASE_URL is required (same as the running app). PGHOST/PGPORT are not used.");
    process.exit(1);
  }
  const pool = getPool();
  for (const name of FILES) {
    const filePath = path.join(__dirname, "..", "db", "migrations", name);
    if (!fs.existsSync(filePath)) {
      console.error("Missing migration file:", filePath);
      process.exit(1);
    }
    const sql = fs.readFileSync(filePath, "utf8");
    console.log("Applying", name, "...");
    await pool.query(sql);
    console.log("OK:", name);
  }
  await endPool();
  console.log("All OTP migrations applied.");
}

main().catch((err) => {
  console.error("Migration failed:", err.message || err);
  process.exit(1);
});
