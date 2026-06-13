/**
 * Probe GET /shipments/active query + HTTP (local).
 * Usage: node scripts/probe-active-shipments.js
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const axios = require("axios");
const { query, endPool } = require("../db/pool");

const BASE = `http://127.0.0.1:${process.env.PORT || 10000}`;

async function probeSql() {
  const { rows: cols } = await query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'loads' AND column_name = 'booking_reference'`
  );
  console.log("[probe] loads.booking_reference column:", cols.length ? "exists" : "MISSING");

  const { rows: users } = await query(
    `SELECT id, email, roles, active_role FROM users WHERE 'carrier' = ANY(roles) OR 'shipper' = ANY(roles) LIMIT 3`
  );
  console.log("[probe] sample users:", users.map((u) => ({ email: u.email, id: u.id })));

  for (const u of users) {
    try {
      const result = await query(
        `SELECT l.id, l.code, s.id AS shipment_id, s.status AS shipment_status, l.status AS load_status
         FROM shipments s
         JOIN loads l ON l.id = s.load_id
         WHERE s.status NOT IN ('delivered', 'closed')
           AND l.status = 'booked'
           AND (l.shipper_id = $1 OR l.assigned_carrier_id = $1)
         LIMIT 5`,
        [u.id]
      );
      console.log(`[probe] sql user ${u.email}:`, result.rows.length, "rows");
    } catch (e) {
      console.error(`[probe] sql FAIL for ${u.email}:`, e.message, e.code);
    }
  }

  // Full active query with booking_reference
  try {
    const uid = users[0]?.id;
    if (uid) {
      const result = await query(
        `SELECT l.id, l.code,
                CASE WHEN l.booking_reference IS NOT NULL AND l.booking_reference LIKE 'space:%' THEN 'CAPACITY' ELSE 'BID' END AS flow_type
         FROM shipments s JOIN loads l ON l.id = s.load_id
         WHERE s.status NOT IN ('delivered', 'closed') AND l.status = 'booked'
           AND (l.shipper_id = $1 OR l.assigned_carrier_id = $1) LIMIT 5`,
        [uid]
      );
      console.log("[probe] full flow query ok:", result.rows);
    }
  } catch (e) {
    console.error("[probe] booking_reference query FAIL:", e.message);
  }
}

async function probeHttp() {
  const email = process.env.E2E_CARRIER_ONLY_EMAIL || "transpak.phase1.carrier@example.com";
  const pass = process.env.PHASE1_RBAC_PASSWORD || "11223344";
  try {
    const login = await axios.post(`${BASE}/api/auth/login`, {
      email,
      password: pass,
      roleHint: "carrier"
    });
    const token = login.data?.data?.token || login.data?.token;
    if (!token) {
      console.warn("[probe] login failed — is server running?");
      return;
    }
    const res = await axios.get(`${BASE}/api/shipments/active`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log("[probe] HTTP /shipments/active:", res.status, {
      success: res.data?.success,
      count: Array.isArray(res.data?.data) ? res.data.data.length : null,
      fallback: res.data?.fallback,
      message: res.data?.message
    });
  } catch (e) {
    console.error("[probe] HTTP FAIL:", e.response?.status, e.response?.data || e.message);
  }
}

async function main() {
  await probeSql();
  await probeHttp();
}

main()
  .catch((e) => {
    console.error("[probe] fatal:", e.message);
    process.exit(1);
  })
  .finally(() => endPool().catch(() => {}));
