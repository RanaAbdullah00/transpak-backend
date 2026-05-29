#!/usr/bin/env node
/**
 * Phase 7 — hostile-environment probe (RBAC, concurrency, dedupe).
 * Requires API + E2E accounts (same as npm run test:phase7).
 *
 *   node scripts/phase7-attack-simulation.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");
const require = createRequire(path.join(backendRoot, "package.json"));
require("dotenv").config({ path: path.join(backendRoot, ".env") });

const { getBaseUrl, hasIntegrationEnv, hasDatabaseUrl, hasSecondCarrier } = require("../test/helpers/config");

const results = [];
function record(id, pass, detail) {
  results.push({ id, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} [${id}] ${detail}`);
}

async function api(method, urlPath, { token, body, workspace } = {}) {
  const base = getBaseUrl();
  const url = new URL(urlPath.startsWith("/") ? urlPath : `/${urlPath}`, `${base}/`);
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (workspace) headers["X-TransPak-Workspace"] = workspace;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(url, {
    method: method.toUpperCase(),
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  return {
    status: res.status,
    ok: res.ok,
    payload: data?.data,
    code: data?.code,
    message: data?.message
  };
}

async function login(email, password, activeRole) {
  const r = await api("POST", "/api/auth/login", {
    body: { email, password, ...(activeRole ? { roleHint: activeRole } : {}) }
  });
  if (!r.payload?.token) throw new Error(`login failed ${email} (${r.status})`);
  let token = r.payload.token;
  let user = r.payload.user;
  if (activeRole && user?.activeRole !== activeRole) {
    const sw = await api("PATCH", "/api/auth/active-role", {
      token,
      body: { activeRole }
    });
    token = sw.payload?.token || token;
    user = sw.payload?.user || user;
  }
  return { token, user };
}

async function runHttpProbes() {
  if (!hasIntegrationEnv()) {
    record("env", false, "Set E2E_SHIPPER_* and E2E_CARRIER_* credentials");
    return;
  }

  const shipper = await login(
    process.env.E2E_SHIPPER_EMAIL,
    process.env.E2E_SHIPPER_PASSWORD,
    "shipper"
  );
  const carrier = await login(
    process.env.E2E_CARRIER_EMAIL,
    process.env.E2E_CARRIER_PASSWORD,
    "carrier"
  );

  const anon = await api("GET", "/api/loads/mine");
  record("rbac-anon", anon.status === 401, `anonymous GET /loads/mine → ${anon.status}`);

  const adminLoads = await api("GET", "/api/loads", { token: carrier.token });
  record(
    "rbac-carrier-market",
    adminLoads.status !== 403 || adminLoads.ok,
    `carrier marketplace list → ${adminLoads.status}`
  );

  const create = await api("POST", "/api/loads/create", {
    token: shipper.token,
    body: {
      cargo: `Phase7 attack ${Date.now()}`,
      origin: "Lahore",
      destination: "Karachi",
      weight: 12,
      vehicleType: "Truck",
      expectedPrice: 150000,
      pickupDate: new Date(Date.now() + 86400000 * 3).toISOString().slice(0, 10),
      deadlineMinutes: 360
    }
  });
  const loadId = create.payload?.id;
  record("load-create", Boolean(loadId), `shipper create load → ${create.status}`);

  let firstBidId = null;
  if (loadId) {
    const [b1, b2] = await Promise.all([
      api("POST", "/api/bids", {
        token: carrier.token,
        body: { loadId, amount: 136000 }
      }),
      api("POST", "/api/bids", {
        token: carrier.token,
        body: { loadId, amount: 136000 }
      })
    ]);
    firstBidId = b1.payload?.id || b2.payload?.id || null;
    const ids = new Set([b1, b2].filter((r) => r.payload?.id).map((r) => String(r.payload.id)));
    record(
      "concurrency-dup-bid",
      ids.size <= 1 && (b1.ok || b2.ok),
      `parallel bid POST ids=${[...ids].join(",") || "none"} statuses=${b1.status}/${b2.status}`
    );

    if (firstBidId) {
      const hijack = await api("PUT", `/api/bids/${firstBidId}/accept`, { token: carrier.token });
      record("idor-accept", hijack.status === 403, `carrier accept → ${hijack.status}`);
    }
  }

  const dedupeTitle = `PHASE7_ATTACK_${Date.now()}`;
  const [n1, n2] = await Promise.all([
    api("POST", "/api/notifications", {
      token: shipper.token,
      body: { title: dedupeTitle, message: "attack dedupe", roleType: "shipper" }
    }),
    api("POST", "/api/notifications", {
      token: shipper.token,
      body: { title: dedupeTitle, message: "attack dedupe", roleType: "shipper" }
    })
  ]);
  record(
    "realtime-dedupe",
    n1.ok && n2.ok && n1.payload?.id === n2.payload?.id,
    `notification ids ${n1.payload?.id} vs ${n2.payload?.id}`
  );

  const sync = await api("GET", "/api/notifications/sync", {
    token: shipper.token,
    workspace: "shipper"
  });
  record(
    "realtime-sync",
    sync.ok && Array.isArray(sync.payload?.items),
    `sync envelope unread=${sync.payload?.unreadCount}`
  );

  if (hasSecondCarrier() && loadId && firstBidId) {
    const carrier2 = await login(
      process.env.E2E_CARRIER2_EMAIL,
      process.env.E2E_CARRIER2_PASSWORD,
      "carrier"
    );
    const bid2 = await api("POST", "/api/bids", {
      token: carrier2.token,
      body: { loadId, amount: 135500 }
    });
    const b2id = bid2.payload?.id;
    if (b2id) {
      const [a, b] = await Promise.all([
        api("PUT", `/api/bids/${firstBidId}/accept`, { token: shipper.token }),
        api("PUT", `/api/bids/${b2id}/accept`, { token: shipper.token })
      ]);
      const wins = [a, b].filter((r) => r.ok).length;
      record("concurrency-accept", wins === 1, `parallel accept wins=${wins}`);
    } else {
      record("concurrency-accept", false, "second carrier bid failed");
    }
  } else {
    record("concurrency-accept", true, "skipped (no load/bid or E2E_CARRIER2_*)");
  }
}

function runUnitSuite() {
  const r = spawnSync(
    process.execPath,
    [
      "--test",
      "test/phase7.state-machine.test.js",
      "test/phase7.static.test.js",
      "test/realtime.dedupe.test.js"
    ],
    { cwd: backendRoot, stdio: "inherit" }
  );
  record("unit-suite", r.status === 0, `exit ${r.status ?? 1}`);
}

console.log(`Phase 7 attack simulation — API ${getBaseUrl()}`);
runUnitSuite();
await runHttpProbes();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.error("Failed:", failed.map((f) => f.id).join(", "));
  process.exit(1);
}

if (hasDatabaseUrl()) {
  console.log("\nTip: run `npm run test:phase7` for full DB + integration coverage.");
}
