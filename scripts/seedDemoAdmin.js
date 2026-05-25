/**
 * Ensure FYP demo admin exists with correct password (production-safe).
 * Usage: TRANSPAK_DEMO_ADMIN_PASSWORD=11223344 node scripts/seedDemoAdmin.js
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const bcrypt = require("bcrypt");
const { getPool, endPool, isDatabaseUrlConfigured } = require("../db/pool");
const userRepo = require("../repositories/userRepo");
const { getDemoAdminEmail, isDemoAdminEnabled } = require("../utils/demoAdmin");

async function main() {
  if (!isDatabaseUrlConfigured()) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }
  const email = String(process.env.TRANSPAK_DEMO_ADMIN_EMAIL || "mrrajpoot.327@gmail.com")
    .trim()
    .toLowerCase();
  const password = String(process.env.TRANSPAK_DEMO_ADMIN_PASSWORD || process.argv[2] || "").trim();
  if (!password) {
    console.error("Set TRANSPAK_DEMO_ADMIN_PASSWORD or pass password as argv[2]");
    process.exit(1);
  }

  getPool();
  const passwordHash = await bcrypt.hash(password, 10);
  const existing = await userRepo.findByEmail(email);
  if (existing) {
    await userRepo.updatePasswordHashByEmail(email, passwordHash);
    await userRepo.setVerifiedByEmail(email, true);
    console.log("[seed] Demo admin password synced:", email);
    await endPool();
    return;
  }
  await userRepo.upsertDemoAdmin({
    email,
    passwordHash,
    roles: ["admin", "shipper", "carrier"],
    activeRole: "admin",
    phone: process.env.TRANSPAK_DEMO_ADMIN_PHONE || "+923001234568",
    cnicNumber: process.env.TRANSPAK_DEMO_ADMIN_CNIC || "35202-DEMO327-1",
    fullName: process.env.TRANSPAK_DEMO_ADMIN_NAME || "Demo Admin"
  });
  await userRepo.updatePasswordHashByEmail(email, passwordHash);
  await userRepo.setVerifiedByEmail(email, true);

  console.log("[seed] Demo admin ready:", email);
  await endPool();
}

main().catch((err) => {
  console.error("[seed] failed:", err.message || err);
  process.exit(1);
});
