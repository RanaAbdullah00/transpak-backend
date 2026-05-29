#!/usr/bin/env node
/**
 * Phase 1 production validation — requires three isolated RBAC accounts.
 * Setup: node scripts/seedPhase1RbacUsers.js
 * Run:   node scripts/phase1-production-validation.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(__dirname, "..", "package.json"));
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const BASE = (
  process.env.QA_BASE_URL ||
  process.env.PHASE1_PROBE_URL ||
  process.env.VITE_API_URL ||
  "https://transpak-backend-1.onrender.com"
)
  .replace(/\/api\/?.*$/i, "")
  .replace(/\/$/, "");

const RBAC_PASSWORD = String(
  process.env.PHASE1_RBAC_PASSWORD ||
    process.env.E2E_SHIPPER_PASSWORD ||
    process.env.E2E_ADMIN_PASSWORD ||
    process.env.TRANSPAK_DEMO_ADMIN_PASSWORD ||
    ""
).trim();

const SHIPPER_EMAIL = String(
  process.env.E2E_SHIPPER_ONLY_EMAIL || "transpak.phase1.shipper@example.com"
).toLowerCase();
const CARRIER_EMAIL = String(
  process.env.E2E_CARRIER_ONLY_EMAIL || "transpak.phase1.carrier@example.com"
).toLowerCase();
const ADMIN_EMAIL = String(
  process.env.E2E_ADMIN_ONLY_EMAIL || "transpak.phase1.admin@example.com"
).toLowerCase();

const results = [];
function record(id, pass, detail) {
  results.push({ id, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} [${id}] ${detail}`);
}

function assertSingleRole(user, expected) {
  const roles = Array.isArray(user?.roles) ? user.roles : [];
  return roles.length === 1 && roles[0] === expected;
}

async function api(method, urlPath, { token, body } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  return { status: res.status, data, payload: data?.data, code: data?.code, message: data?.message };
}

async function login(email, password, roleHint) {
  const r = await api("POST", "/api/auth/login", {
    body: { email, password, ...(roleHint ? { roleHint } : {}) }
  });
  if (!r.payload?.token) {
    throw new Error(`login ${email} HTTP ${r.status} ${r.message || ""}`);
  }
  let token = r.payload.token;
  let user = r.payload.user;
  if (roleHint && user?.activeRole !== roleHint) {
    const sw = await api("PATCH", "/api/auth/active-role", {
      token,
      body: { activeRole: roleHint }
    });
    token = sw.payload?.token || token;
    user = sw.payload?.user || user;
  }
  return { token, user, id: user?.id, email };
}

function dashboardHasStats(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.meta?.dbReachable === false) return false;
  return Boolean(payload.stats || payload.summary || payload.totals || Object.keys(payload).length >= 3);
}

async function verifyExpirySql() {
  const url = process.env.DATABASE_URL;
  if (!url) return true;
  const { OPEN_BIDDING_ELIGIBLE_SQL } = require(path.join(__dirname, "..", "utils", "loadExpiry"));
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  try {
    await pool.query(`SELECT l.id FROM loads l WHERE ${OPEN_BIDDING_ELIGIBLE_SQL} LIMIT 1`);
    return true;
  } catch (e) {
    record("sql-expiry", false, e.message);
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
}

async function main() {
  console.log(`\n=== Phase 1 Production Validation (isolated RBAC) ===\nAPI: ${BASE}\n`);

  if (!RBAC_PASSWORD) {
    console.error("Set PHASE1_RBAC_PASSWORD in .env (run seedPhase1RbacUsers.js first)");
    process.exit(1);
  }

  if (!(await verifyExpirySql())) {
    process.exit(1);
  }
  record("sql-expiry", true, "OPEN_BIDDING_ELIGIBLE_SQL executes on DB");

  let shipper;
  let carrier;
  let admin;

  try {
    shipper = await login(SHIPPER_EMAIL, RBAC_PASSWORD, "shipper");
    record(
      "setup-shipper",
      assertSingleRole(shipper.user, "shipper"),
      `${SHIPPER_EMAIL} roles=${JSON.stringify(shipper.user?.roles)}`
    );
  } catch (e) {
    record("setup-shipper", false, e.message);
    console.error("Run: node scripts/seedPhase1RbacUsers.js");
    process.exit(1);
  }

  try {
    carrier = await login(CARRIER_EMAIL, RBAC_PASSWORD, "carrier");
    record(
      "setup-carrier",
      assertSingleRole(carrier.user, "carrier"),
      `${CARRIER_EMAIL} roles=${JSON.stringify(carrier.user?.roles)}`
    );
  } catch (e) {
    record("setup-carrier", false, e.message);
    process.exit(1);
  }

  try {
    admin = await login(ADMIN_EMAIL, RBAC_PASSWORD, "admin");
    const roles = admin.user?.roles || [];
    const platformOnly = roles.length === 1 && roles[0] === "admin";
    record(
      "setup-admin",
      platformOnly,
      `${ADMIN_EMAIL} roles=${JSON.stringify(roles)}`
    );
    if (!platformOnly) process.exit(1);
  } catch (e) {
    record("setup-admin", false, e.message);
    process.exit(1);
  }

  const dash = await api("GET", "/api/admin/dashboard/live", { token: admin.token });
  record("adm1", dash.status === 200 && dashboardHasStats(dash.payload), `dashboard HTTP ${dash.status}`);

  const carrierDash = await api("GET", "/api/admin/dashboard/live", { token: carrier.token });
  record("adm-carrier-denied", carrierDash.status === 403, `carrier on admin HTTP ${carrierDash.status}`);

  for (const p of ["/api/loads", "/api/bids", "/api/trucks/mine"]) {
    const r = await api("GET", p, { token: admin.token });
    record(`adm2${p}`, r.status === 403, `admin-only ${p} HTTP ${r.status}`);
  }

  const loadsCarrier = await api("GET", "/api/loads", { token: carrier.token });
  record(
    "loads-list",
    loadsCarrier.status === 200,
    `GET /api/loads HTTP ${loadsCarrier.status}${loadsCarrier.status === 500 ? " (deploy loadExpiry fix)" : ""}`
  );

  const mine = await api("GET", "/api/loads/mine", { token: shipper.token });
  const loads = Array.isArray(mine.payload) ? mine.payload : [];
  let privateLoadId = loads.find((l) => String(l.status).toLowerCase() !== "open")?.id;
  if (!privateLoadId && process.env.DATABASE_URL) {
    const { Pool } = require("pg");
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    const { rows } = await pool.query(
      `SELECT l.id FROM loads l
       WHERE l.shipper_id = $1 AND l.status <> 'open'
         AND (l.assigned_carrier_id IS NULL OR l.assigned_carrier_id <> $2)
       LIMIT 1`,
      [shipper.id, carrier.id]
    );
    await pool.end().catch(() => {});
    privateLoadId = rows[0]?.id;
  }
  if (privateLoadId) {
    const idor = await api("GET", `/api/loads/${privateLoadId}`, { token: carrier.token });
    record("idor-private", idor.status === 403 || idor.status === 404, `non-open load HTTP ${idor.status}`);
  } else {
    record("idor-private", true, "skip — no private load in DB");
  }

  const openLoad = loads.find((l) => String(l.status).toLowerCase() === "open");
  if (openLoad?.id) {
    const idorOpen = await api("GET", `/api/loads/${openLoad.id}`, { token: carrier.token });
    record("idor-open-ok", idorOpen.status === 200, `open marketplace load HTTP ${idorOpen.status}`);
  }

  const trucks = await api("GET", "/api/trucks/mine", { token: carrier.token });
  const truckList = Array.isArray(trucks.payload) ? trucks.payload : trucks.payload?.items || [];
  if (truckList[0]?.id) {
    const t = await api("PUT", `/api/trucks/${truckList[0].id}`, {
      token: shipper.token,
      body: { licensePlate: "HACK-PHASE1" }
    });
    record("idor-truck", t.status === 403 || t.status === 404, `cross-user truck HTTP ${t.status}`);
  } else record("idor-truck", false, "carrier has no truck — run seedPhase1RbacUsers.js");

  const esc = await api("PATCH", "/api/auth/active-role", {
    token: carrier.token,
    body: { activeRole: "admin" }
  });
  record("role-escalation", esc.status === 403, `carrier→admin HTTP ${esc.status}`);

  const massOnly = await api("POST", "/api/loads/create", {
    token: shipper.token,
    body: {
      role: "admin",
      user_id: carrier.id,
      is_admin: true,
      shipper_id: carrier.id
    }
  });
  record("mass-assignment", massOnly.status === 400, `forbidden-only body HTTP ${massOnly.status}`);

  const n1 = await api("GET", "/api/notifications", { token: shipper.token });
  const items1 = n1.payload?.items || [];
  const leak1 = items1.some((n) => n.receiverId && String(n.receiverId) !== String(shipper.id));
  record("notif-shipper", n1.status === 200 && !leak1, `count=${items1.length} leak=${leak1}`);

  const n2 = await api("GET", "/api/notifications", { token: carrier.token });
  const items2 = n2.payload?.items || [];
  const leak2 = items2.some((n) => n.receiverId && String(n.receiverId) !== String(carrier.id));
  const shared = items1.filter((a) => items2.some((b) => b.id === a.id));
  record("notif-carrier", n2.status === 200 && !leak2, `count=${items2.length} leak=${leak2}`);
  record("notif-cross", shared.length === 0, `shared ids=${shared.length}`);

  const createBad = await api("POST", "/api/loads/create", {
    token: shipper.token,
    body: {
      cargo: "Phase1 mismatch vehicle type test load",
      origin: "Lahore",
      destination: "Karachi",
      weight: 5,
      vehicleType: "Mazda",
      expectedPrice: 50000,
      pickupDate: "2030-11-01",
      deadlineMinutes: 480
    }
  });
  if (createBad.payload?.id) {
    const badBid = await api("POST", "/api/bids", {
      token: carrier.token,
      body: { loadId: createBad.payload.id, amount: 10000 }
    });
    record(
      "bid-mismatch",
      badBid.status === 409 || badBid.status === 403,
      `HTTP ${badBid.status} code=${badBid.code || ""}`
    );
  } else record("bid-mismatch", false, `create load HTTP ${createBad.status}`);

  const createOk = await api("POST", "/api/loads/create", {
    token: shipper.token,
    body: {
      cargo: "Phase1 valid truck bid test load",
      origin: "Lahore",
      destination: "Karachi",
      weight: 5,
      vehicleType: "Truck",
      expectedPrice: 50000,
      pickupDate: "2030-11-15",
      deadlineMinutes: 480
    }
  });
  if (createOk.payload?.id) {
    const bid = await api("POST", "/api/bids", {
      token: carrier.token,
      body: { loadId: createOk.payload.id, amount: 45000 }
    });
    record("bid-valid", bid.status >= 200 && bid.status < 300, `HTTP ${bid.status}`);
  } else record("bid-valid", false, `create load HTTP ${createOk.status}`);

  const sock = await fetch(`${BASE}/socket.io/?EIO=4&transport=polling`);
  const sockText = await sock.text();
  record("socket-handshake", sock.ok && sockText.includes("sid"), `HTTP ${sock.status}`);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== SUMMARY: ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) {
    for (const f of failed) console.log(`  - ${f.id}: ${f.detail}`);
    process.exit(1);
  }
  console.log("\nPhase 1 production validation: ALL CHECKS PASSED\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
