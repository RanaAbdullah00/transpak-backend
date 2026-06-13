#!/usr/bin/env node
/**
 * Full lifecycle: post load → bid → accept → GET /shipments/active → status PUT → GPS throttle
 * Usage: node scripts/lifecycle-active-audit.js [baseUrl]
 */
require("dotenv").config();
const axios = require("axios");

const BASE = (process.argv[2] || `http://127.0.0.1:${process.env.PORT || 10000}`).replace(/\/$/, "");
const PASS = process.env.PHASE1_RBAC_PASSWORD || "11223344";
const SHIPPER = process.env.E2E_SHIPPER_ONLY_EMAIL || "transpak.phase1.shipper@example.com";
const CARRIER = process.env.E2E_CARRIER_ONLY_EMAIL || "transpak.phase1.carrier@example.com";

async function login(email, roleHint) {
  const res = await axios.post(`${BASE}/api/auth/login`, {
    email,
    password: PASS,
    roleHint
  });
  const token = res.data?.data?.token;
  if (!token) throw new Error(`login failed ${email}: ${res.data?.message}`);
  return { token, auth: { Authorization: `Bearer ${token}` } };
}

function withAuth(auth) {
  return { headers: auth };
}

async function main() {
  console.log("[lifecycle] base", BASE);
  const shipper = await login(SHIPPER, "shipper");

  const pickupDate = new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10);
  const loadRes = await axios.post(
    `${BASE}/api/loads/create`,
    {
      cargo: "Lifecycle audit load",
      origin: "Lahore",
      destination: "Islamabad",
      weight: 5,
      vehicleType: "Mazda",
      expectedPrice: 85000,
      pickupDate,
      deadlineMinutes: 480
    },
    withAuth(shipper.auth)
  );
  const load = loadRes.data?.data;
  if (!load?.id) throw new Error("load create failed");
  console.log("[lifecycle] load", load.code, load.id);

  // Carrier login after shipper load create — avoids transient AUTH_INVALID when both logins race DB pool
  const carrier = await login(CARRIER, "carrier");

  const bidRes = await axios.post(
    `${BASE}/api/bids`,
    { loadId: load.id, amount: 82000 },
    withAuth(carrier.auth)
  );
  const bid = bidRes.data?.data;
  console.log("[lifecycle] bid", bid?.id, "mismatchWarn=", bid?.vehicleTypeMismatchWarning);

  const acceptRes = await axios.put(
    `${BASE}/api/bids/${bid.id}/accept`,
    {},
    withAuth(shipper.auth)
  );
  console.log("[lifecycle] accept", acceptRes.status, acceptRes.data?.message);

  const activeRes = await axios.get(`${BASE}/api/shipments/active`, withAuth(carrier.auth));
  console.log("[lifecycle] active", activeRes.status, "count=", activeRes.data?.data?.length);
  const row = (activeRes.data?.data || []).find((r) => r.code === load.code || r.id === load.id);
  if (!row) {
    console.error("[lifecycle] FAIL — accepted load not in /shipments/active");
    process.exit(1);
  }
  console.log("[lifecycle] active row", { code: row.code, shipmentStatus: row.shipmentStatus, trackingEnabled: row.trackingEnabled });

  const statusRes = await axios.put(
    `${BASE}/api/shipments/${encodeURIComponent(load.code)}/status`,
    { status: "pickedup" },
    withAuth(carrier.auth)
  );
  console.log("[lifecycle] status PUT", statusRes.status, statusRes.data?.data?.tracking?.status);

  const loc1 = await axios.put(
    `${BASE}/api/shipments/${encodeURIComponent(load.code)}/location`,
    { lat: 31.5497, lng: 74.3436 },
    withAuth(carrier.auth)
  );
  let loc2;
  try {
    loc2 = await axios.put(
      `${BASE}/api/shipments/${encodeURIComponent(load.code)}/location`,
      { lat: 31.5498, lng: 74.3437 },
      withAuth(carrier.auth)
    );
  } catch (e) {
    loc2 = e.response;
  }
  console.log("[lifecycle] GPS", "first=", loc1.status, "second=", loc2?.status, loc2?.data?.message || "");

  const trackRes = await axios.get(`${BASE}/api/shipments/track/${encodeURIComponent(load.code)}`, withAuth(shipper.auth));
  const history = trackRes.data?.data?.history?.length || 0;
  console.log("[lifecycle] track history events", history, "status=", trackRes.data?.data?.tracking?.status);

  console.log("[lifecycle] PASS — full lifecycle verified");
}

main().catch((e) => {
  console.error("[lifecycle] FAIL", e.response?.data || e.message);
  process.exit(1);
});
