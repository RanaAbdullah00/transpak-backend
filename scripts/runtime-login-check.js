/**
 * Quick local check: DB + demo admin login path (no HTTP server).
 * Usage: node scripts/runtime-login-check.js
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const bcrypt = require("bcrypt");
const { query, endPool } = require("../db/pool");
const { signToken } = require("../utils/jwt");

const EMAIL = "mrrajpoot.327@gmail.com";
const PASSWORD = "11223344";

async function main() {
  await query("SELECT 1");
  console.log("[check] db ping ok");

  const { rows } = await query(
    `SELECT id, email, roles, active_role, password_hash, verified, is_profile_complete
     FROM users WHERE lower(trim(email)) = lower(trim($1))`,
    [EMAIL]
  );
  const row = rows[0];
  if (!row) {
    console.error("[check] user not found:", EMAIL);
    process.exit(1);
  }
  const ok = await bcrypt.compare(PASSWORD, row.password_hash);
  if (!ok) {
    console.error("[check] password mismatch — run seed:demo-admin or set TRANSPAK_DEMO_ADMIN_PASSWORD");
    process.exit(1);
  }
  const token = signToken({
    id: row.id,
    roles: row.roles,
    activeRole: row.active_role
  });
  console.log("[check] login path ok", {
    email: row.email,
    activeRole: row.active_role,
    roles: row.roles,
    verified: row.verified,
    profileComplete: row.is_profile_complete,
    tokenLen: token.length
  });
}

main()
  .catch((err) => {
    console.error("[check] failed:", err?.message || err, err?.code || "");
    process.exit(1);
  })
  .finally(() => endPool().catch(() => {}));
