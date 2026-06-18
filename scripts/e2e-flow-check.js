/**
 * API-level E2E smoke: shipper post load → carrier bid → tracking route.
 * Usage: node scripts/e2e-flow-check.js [baseUrl]
 */
require("dotenv").config();
const axios = require("axios");

const BASE = (
  process.argv[2] ||
  process.env.QA_BASE_URL ||
  "https://transpak-backend-1.onrender.com"
).replace(/\/$/, "");

async function login(email, password, roleHint) {
  const res = await axios.post(`${BASE}/api/auth/login`, {
    email,
    password,
    ...(roleHint ? { roleHint } : {})
  });
  let token = res.data?.data?.token;
  let user = res.data?.data?.user;
  if (!token) throw new Error(`login failed for ${email}`);

  const want = roleHint ? String(roleHint).trim().toLowerCase() : "";
  if (want && user?.activeRole !== want) {
    const switched = await axios.patch(
      `${BASE}/api/auth/active-role`,
      { activeRole: want },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    token = switched.data?.data?.token || token;
    user = switched.data?.data?.user || user;
  }

  return { token, user, headers: { Authorization: `Bearer ${token}` } };
}

async function authedRequest(fn, { retries = 3, delayMs = 400 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const code = err.response?.data?.code;
      const status = err.response?.status;
      if (status === 401 && code === "AUTH_INVALID" && attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function main() {
  const shipperEmail = process.env.E2E_SHIPPER_EMAIL;
  const shipperPass = process.env.E2E_SHIPPER_PASSWORD;
  const carrierEmail = process.env.E2E_CARRIER_EMAIL;
  const carrierPass = process.env.E2E_CARRIER_PASSWORD;

  if (!shipperEmail || !shipperPass || !carrierEmail || !carrierPass) {
    console.log(
      "[e2e] Set E2E_SHIPPER_EMAIL, E2E_SHIPPER_PASSWORD, E2E_CARRIER_EMAIL, E2E_CARRIER_PASSWORD in .env"
    );
    console.log("[e2e] Skipping full flow — running health only.");
    const health = await axios.get(`${BASE}/api/health`);
    console.log("[e2e] health", health.data?.data?.db);
    process.exit(0);
  }

  const shipper = await login(shipperEmail, shipperPass, "shipper");
  const pickupDate = new Date(Date.now() + 86400000 * 3).toISOString().slice(0, 10);

  const loadRes = await authedRequest(() =>
    axios.post(
      `${BASE}/api/loads/create`,
      {
        cargo: "E2E QA load",
        origin: "Lahore",
        destination: "Karachi",
        weight: 500,
        vehicleType: "Truck",
        expectedPrice: 150000,
        pickupDate,
        deadlineMinutes: 360
      },
      { headers: shipper.headers }
    )
  );
  const load = loadRes.data?.data;
  console.log("[e2e] load created", load?.code, load?.id);

  const routeRes = await axios.get(`${BASE}/api/maps/route`, {
    params: { origin: "Lahore", destination: "Karachi" },
    headers: shipper.headers
  });
  const route = routeRes.data?.data;
  console.log("[e2e] route", {
    points: route?.coordinates?.length,
    source: route?.source,
    fallback: route?.fallback,
    distanceKm: route?.distanceKm
  });

  const carrier = await login(carrierEmail, carrierPass, "carrier");
  const bidRes = await authedRequest(() =>
    axios.post(`${BASE}/api/bids`, { loadId: load.id, amount: 140000 }, { headers: carrier.headers })
  );
  const bid = bidRes.data?.data;
  console.log("[e2e] bid placed", bid?.id || bid?.status);

  const acceptRes = await axios.put(
    `${BASE}/api/bids/${bid.id}/accept`,
    {},
    { headers: shipper.headers }
  );
  console.log("[e2e] bid accepted", acceptRes.data?.data?.status || acceptRes.status);

  const activeRes = await axios.get(`${BASE}/api/shipments/active`, { headers: shipper.headers });
  const active = activeRes.data?.data;
  const activeList = Array.isArray(active) ? active : active?.items || [];
  console.log("[e2e] active shipments", activeList.length);

  const trackRes = await axios.get(`${BASE}/api/shipments/track/${encodeURIComponent(load.code)}`, {
    headers: shipper.headers
  });
  const track = trackRes.data?.data;
  console.log("[e2e] tracking", {
    refKey: track?.refKey,
    routePoints: track?.liveTrackingMap?.coordinates?.length,
    status: track?.tracking?.status,
    distanceKm: track?.distanceKm
  });

  console.log("[e2e] OK — load → bid → accept → tracking chain complete.");
}

main().catch((e) => {
  console.error("[e2e] failed", e.response?.data || e.message);
  process.exit(1);
});
