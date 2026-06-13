#!/usr/bin/env node
/**
 * Ensure three isolated Phase 1 RBAC test accounts (single role each).
 * Usage: PHASE1_RBAC_PASSWORD=secret node scripts/seedPhase1RbacUsers.js
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const bcrypt = require("bcrypt");
const { getPool, endPool, query, isDatabaseUrlConfigured } = require("../db/pool");
const userRepo = require("../repositories/userRepo");

const ACCOUNTS = [
  {
    key: "shipper",
    emailEnv: "E2E_SHIPPER_ONLY_EMAIL",
    defaultEmail: "transpak.phase1.shipper@example.com",
    roles: ["shipper"],
    activeRole: "shipper",
    phone: "+923001111001",
    cnic: "35201-1000001-1",
    fullName: "Phase1 Shipper Only"
  },
  {
    key: "carrier",
    emailEnv: "E2E_CARRIER_ONLY_EMAIL",
    defaultEmail: "transpak.phase1.carrier@example.com",
    roles: ["carrier"],
    activeRole: "carrier",
    phone: "+923001111002",
    cnic: "35201-2000002-2",
    fullName: "Phase1 Carrier Only",
    seedTruck: true
  },
  {
    key: "admin",
    emailEnv: "E2E_ADMIN_ONLY_EMAIL",
    defaultEmail: "transpak.phase1.admin@example.com",
    roles: ["admin"],
    activeRole: "admin",
    phone: "+923001111003",
    cnic: "35201-3000003-3",
    fullName: "Phase1 Admin Only"
  }
];

async function upsertIsolatedUser({ email, passwordHash, roles, activeRole, phone, cnic, fullName }) {
  const existing = await userRepo.findByEmail(email);
  if (existing) {
    await query(
      `UPDATE users
       SET password_hash = $2,
           roles = $3::text[],
           active_role = $4,
           phone = $5,
           cnic_number = $6,
           full_name = $7,
           verified = true,
           blocked = false,
           is_profile_complete = true,
           updated_at = now()
       WHERE id = $1`,
      [existing.id, passwordHash, roles, activeRole, phone, cnic, fullName]
    );
    return existing.id;
  }
  const created = await userRepo.createUser({
    email,
    passwordHash,
    roles,
    activeRole,
    phone,
    cnicNumber: cnic,
    fullName,
    verified: true
  });
  await query(
    `UPDATE users SET is_profile_complete = true, verified = true WHERE id = $1`,
    [created.id]
  );
  return created.id;
}

async function ensureCarrierTruck(userId) {
  const { rows } = await query(
    `SELECT id FROM trucks WHERE user_id = $1 AND COALESCE(status, 'approved') = 'approved' LIMIT 1`,
    [userId]
  );
  if (rows[0]) return;
  const suffix = String(userId).replace(/-/g, "").slice(0, 12);
  await query(
    `INSERT INTO trucks (
       user_id, engine_number, truck_type, capacity, license_plate,
       truck_card_front_image, truck_card_back_image, status, is_default
     )
     VALUES ($1, $2, 'Truck', 25, $3, $4, $5, 'approved', true)`,
    [
      userId,
      `PHASE1-ENG-${suffix}`,
      `P1-${suffix.slice(0, 8)}`,
      "https://res.cloudinary.com/demo/image/upload/sample.jpg",
      "https://res.cloudinary.com/demo/image/upload/sample.jpg"
    ]
  );
}

async function main() {
  if (!isDatabaseUrlConfigured()) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }
  const password = String(
    process.env.PHASE1_RBAC_PASSWORD ||
      process.env.E2E_SHIPPER_PASSWORD ||
      ""
  ).trim();
  if (!password) {
    console.error("Set PHASE1_RBAC_PASSWORD (or E2E_SHIPPER_PASSWORD)");
    process.exit(1);
  }

  getPool();
  const passwordHash = await bcrypt.hash(password, 10);
  const created = [];

  for (const spec of ACCOUNTS) {
    const email = String(process.env[spec.emailEnv] || spec.defaultEmail)
      .trim()
      .toLowerCase();
    const userId = await upsertIsolatedUser({
      email,
      passwordHash,
      roles: spec.roles,
      activeRole: spec.activeRole,
      phone: spec.phone,
      cnic: spec.cnic,
      fullName: spec.fullName
    });
    if (spec.seedTruck) await ensureCarrierTruck(userId);
    created.push({ role: spec.key, email, roles: spec.roles });
    console.log(`[phase1-rbac] ${spec.key}: ${email} roles=${spec.roles.join(",")}`);
  }

  console.log("\nAdd to transpak-backend/.env for validation:");
  console.log(`PHASE1_RBAC_PASSWORD=${password ? "(your password)" : ""}`);
  for (const spec of ACCOUNTS) {
    const email = String(process.env[spec.emailEnv] || spec.defaultEmail).trim().toLowerCase();
    console.log(`${spec.emailEnv}=${email}`);
  }
  console.log(`E2E_SHIPPER_PASSWORD=${password ? "(same as PHASE1_RBAC_PASSWORD)" : ""}`);
  console.log(`E2E_CARRIER_PASSWORD=${password ? "(same)" : ""}`);
  console.log(`E2E_ADMIN_PASSWORD=${password ? "(same)" : ""}`);

  await endPool();
}

main().catch((err) => {
  console.error("[phase1-rbac] failed:", err.message || err);
  process.exit(1);
});
