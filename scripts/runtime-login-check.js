/**
 * Quick local check: DB + admin login path (no HTTP server).
 * Usage: CHECK_LOGIN_EMAIL=... CHECK_LOGIN_PASSWORD=... node scripts/runtime-login-check.js
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const bcrypt = require("bcrypt");
const { query, endPool } = require("../db/pool");
const { signToken } = require("../utils/jwt");

const EMAIL = String(process.env.CHECK_LOGIN_EMAIL || process.env.DEV_ADMIN_EMAIL || "").trim();
const PASSWORD = String(process.env.CHECK_LOGIN_PASSWORD || process.env.DEV_ADMIN_PASSWORD || "").trim();

async function main() {
  if (!EMAIL || !PASSWORD) {
    console.error("[check] Set CHECK_LOGIN_EMAIL/CHECK_LOGIN_PASSWORD or DEV_ADMIN_EMAIL/DEV_ADMIN_PASSWORD");
    process.exit(1);
  }
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
    console.error("[check] password mismatch — verify CHECK_LOGIN_PASSWORD / DEV_ADMIN_PASSWORD");
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
