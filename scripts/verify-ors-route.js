/**
 * ORS proxy check (requires running server + ORS_API_KEY in .env).
 * Usage: node scripts/verify-ors-route.js [baseUrl]
 */
require("dotenv").config();
const axios = require("axios");

const BASE = (process.argv[2] || "http://127.0.0.1:10000").replace(/\/$/, "");
const EMAIL = process.env.TRANSPAK_DEMO_ADMIN_EMAIL || "mrrajpoot.327@gmail.com";
const PASS = process.env.TRANSPAK_DEMO_ADMIN_PASSWORD || "11223344";

async function main() {
  const login = await axios.post(`${BASE}/api/auth/login`, {
    email: EMAIL,
    password: PASS,
    roleHint: "shipper"
  });
  let token = login.data?.data?.token;
  if (!token) {
    console.error("[ors] login failed");
    process.exit(1);
  }

  if (login.data?.data?.user?.activeRole === "admin") {
    const switched = await axios.patch(
      `${BASE}/api/auth/active-role`,
      { activeRole: "shipper" },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    token = switched.data?.data?.token || token;
  }

  const route = await axios.get(`${BASE}/api/maps/route`, {
    params: { origin: "Lahore", destination: "Karachi" },
    headers: { Authorization: `Bearer ${token}` }
  });

  const data = route.data?.data;
  const ok =
    Array.isArray(data?.coordinates) &&
    data.coordinates.length >= 2 &&
    typeof data.distanceKm === "number" &&
    typeof data.source === "string" &&
    typeof data.fallback === "boolean";

  console.log("[ors] response", {
    ok,
    points: data?.coordinates?.length,
    distanceKm: data?.distanceKm,
    durationSeconds: data?.durationSeconds,
    source: data?.source,
    fallback: data?.fallback
  });

  if (!ok) {
    console.error("[ors] invalid normalized shape");
    process.exit(1);
  }

  if (data.fallback) {
    console.warn("[ors] WARN: fallback route — check ORS_API_KEY quota/network");
  } else {
    console.log("[ors] OK — OpenRouteService route returned");
  }
}

main().catch((e) => {
  console.error(e.response?.data || e.message);
  process.exit(1);
});
