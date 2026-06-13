require("dotenv").config();
const axios = require("axios");
const { query, endPool } = require("../db/pool");

const BASE = "https://transpak-backend-1.onrender.com";
const PASS = process.env.PHASE1_RBAC_PASSWORD || "11223344";
const CARRIER = process.env.E2E_CARRIER_ONLY_EMAIL || "transpak.phase1.carrier@example.com";

function withAuth(auth) {
  return { headers: auth };
}

async function main() {
  const login = await axios.post(`${BASE}/api/auth/login`, {
    email: CARRIER,
    password: PASS,
    roleHint: "carrier"
  });
  const auth = { Authorization: `Bearer ${login.data.data.token}` };

  const { rows } = await query(
    `SELECT l.code, s.status
     FROM shipments s
     JOIN loads l ON l.id = s.load_id
     JOIN users u ON u.id = l.assigned_carrier_id
     WHERE u.email = $1 AND s.status NOT IN ('delivered', 'closed')
     ORDER BY s.updated_at DESC LIMIT 1`,
    [CARRIER]
  );
  const code = rows[0]?.code;
  console.log("[prod-track] existing active load", code, rows[0]?.status);
  if (!code) return;

  const track = await axios
    .get(`${BASE}/api/shipments/track/${encodeURIComponent(code)}`, withAuth(auth))
    .catch((e) => e.response);
  console.log("[prod-track] GET track", track.status, "history=", track.data?.data?.history?.length);

  const statusGet = await axios
    .get(`${BASE}/api/shipments/${encodeURIComponent(code)}/status`, withAuth(auth))
    .catch((e) => e.response);
  console.log("[prod-track] GET status", statusGet.status, statusGet.data?.data?.status);
}

main()
  .catch((e) => console.error(e.response?.data || e.message))
  .finally(() => endPool().catch(() => {}));
