require("dotenv").config();
const axios = require("axios");
const { query, endPool } = require("../db/pool");

const BASE = "https://transpak-backend-1.onrender.com";
const PASS = process.env.PHASE1_RBAC_PASSWORD || "11223344";
const SHIPPER = process.env.E2E_SHIPPER_ONLY_EMAIL || "transpak.phase1.shipper@example.com";
const CARRIER = process.env.E2E_CARRIER_ONLY_EMAIL || "transpak.phase1.carrier@example.com";

function withAuth(auth) {
  return { headers: auth };
}

async function login(email, roleHint) {
  const res = await axios.post(`${BASE}/api/auth/login`, { email, password: PASS, roleHint });
  const token = res.data?.data?.token;
  if (!token) throw new Error(`login failed: ${res.data?.message}`);
  return { token, auth: { Authorization: `Bearer ${token}` } };
}

async function main() {
  const health = await axios.get(`${BASE}/api/health`);
  console.log("[prod-verify] build", health.data?.data?.build);

  const { rows: trucks } = await query(
    `SELECT t.vehicle_type, t.status
     FROM trucks t
     JOIN users u ON u.id = t.carrier_id
     WHERE u.email = $1`,
    [CARRIER]
  );
  const vehicleType = trucks.find((t) => t.status === "approved")?.vehicle_type || trucks[0]?.vehicle_type || "Mazda";
  console.log("[prod-verify] carrier vehicleType", vehicleType, "trucks", trucks.length);

  const shipper = await login(SHIPPER, "shipper");
  const pickupDate = new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10);
  const loadRes = await axios.post(
    `${BASE}/api/loads/create`,
    {
      cargo: "Production verify load",
      origin: "Lahore",
      destination: "Islamabad",
      weight: 5,
      vehicleType,
      expectedPrice: 85000,
      pickupDate,
      deadlineMinutes: 480
    },
    withAuth(shipper.auth)
  );
  const load = loadRes.data?.data;
  console.log("[prod-verify] load", load?.code, load?.status);

  const carrier = await login(CARRIER, "carrier");
  const bidRes = await axios.post(
    `${BASE}/api/bids`,
    { loadId: load.id, amount: 82000 },
    withAuth(carrier.auth)
  );
  console.log("[prod-verify] bid", bidRes.status, bidRes.data?.data?.id);

  const acceptRes = await axios.put(
    `${BASE}/api/bids/${bidRes.data.data.id}/accept`,
    {},
    withAuth(shipper.auth)
  );
  console.log("[prod-verify] accept", acceptRes.status);

  const activeRes = await axios.get(`${BASE}/api/shipments/active`, withAuth(carrier.auth)).catch((e) => e.response);
  console.log("[prod-verify] active", activeRes.status, activeRes.data?.code, "count=", activeRes.data?.data?.length);

  if (activeRes.status === 200) {
    const ref = load.code;
    const statusRes = await axios.put(
      `${BASE}/api/shipments/${encodeURIComponent(ref)}/status`,
      { status: "pickedup" },
      withAuth(carrier.auth)
    );
    console.log("[prod-verify] status", statusRes.status, statusRes.data?.data?.tracking?.status);

    const trackRes = await axios.get(`${BASE}/api/shipments/track/${encodeURIComponent(ref)}`, withAuth(shipper.auth));
    console.log("[prod-verify] track history", trackRes.data?.data?.history?.length);
  }
}

main()
  .catch((e) => console.error("[prod-verify] FAIL", e.response?.data || e.message))
  .finally(() => endPool().catch(() => {}));
