/**
 * HTTP smoke: login + POST /api/loads/create (logs request/response).
 * Usage: node scripts/qa-api-smoke.js [baseUrl]
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const BASE = (process.argv[2] || "http://127.0.0.1:10000").replace(/\/$/, "");

async function json(method, urlPath, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

async function main() {
  console.log("[qa-api] base:", BASE);

  const login = await json("POST", "/api/auth/login", {
    email: "mrrajpoot.327@gmail.com",
    password: "11223344",
    roleHint: "shipper"
  });
  console.log("[qa-api] POST /api/auth/login", login.status, JSON.stringify(login.data, null, 2));
  let token = login.data?.data?.token;
  const user = login.data?.data?.user;
  if (!token) process.exit(1);

  if (user?.activeRole !== "shipper") {
    const switchRole = await json("PATCH", "/api/auth/active-role", { activeRole: "shipper" }, token);
    console.log("[qa-api] PATCH /api/auth/active-role", switchRole.status, switchRole.data?.message || "");
    token = switchRole.data?.data?.token || token;
  }

  const loadBody = {
    cargo: "QA runtime load",
    origin: "Lahore",
    destination: "Karachi",
    weight: 1200,
    vehicleType: "Truck",
    expectedPrice: 150000,
    pickupDate: new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10),
    deadlineMinutes: 360,
    deadlineHours: 6
  };
  console.log("[qa-api] POST /api/loads/create request", loadBody);
  const create = await json("POST", "/api/loads/create", loadBody, token);
  console.log("[qa-api] POST /api/loads/create", create.status, JSON.stringify(create.data, null, 2));

  if (user?.profileComplete === false) {
    console.log("[qa-api] note: profileComplete=false — expect 403 PROFILE_INCOMPLETE unless DB updated");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
