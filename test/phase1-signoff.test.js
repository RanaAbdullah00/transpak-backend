/**
 * Phase 1 final sign-off — static gates + optional live HTTP (QA_BASE_URL + E2E_*).
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { integrationSuiteSkipReason, skipAdminReason } = require("./helpers/config");
const { api, login } = require("./helpers/http");

const root = path.join(__dirname, "..");

describe("Phase 1 — deployment & error safety (static)", () => {
  it("frontend production env points at Render API origin", () => {
    const envProd = path.join(root, "..", "transpak-frontend", ".env.production");
    if (!fs.existsSync(envProd)) return;
    const raw = fs.readFileSync(envProd, "utf8");
    const m = raw.match(/VITE_API_URL=(.+)/);
    assert.ok(m, "VITE_API_URL missing in .env.production");
    const url = m[1].trim();
    assert.ok(/onrender\.com/i.test(url), `Expected Render API URL, got ${url}`);
    assert.ok(!/pages\.dev/i.test(url), "VITE_API_URL must not be Cloudflare Pages host");
  });

  it("JWT payload does not embed roles (DB is authority)", () => {
    const src = fs.readFileSync(path.join(root, "utils", "jwt.js"), "utf8");
    const signBlock = src.slice(src.indexOf("function signToken"), src.indexOf("function verifyToken"));
    assert.ok(!signBlock.includes("roles"));
    assert.ok(signBlock.includes("sub:"));
  });

  it("commercial resourceAuth has no admin read bypass", () => {
    const src = fs.readFileSync(path.join(root, "utils", "resourceAuth.js"), "utf8");
    const readLoad = src.slice(src.indexOf("function canReadLoad"), src.indexOf("function canMutateLoadAsShipper"));
    assert.ok(!readLoad.includes("hasAdminRole"));
    const parties = src.slice(
      src.indexOf("function canAccessShipmentParties"),
      src.indexOf("function assertShipmentParties")
    );
    assert.ok(!parties.includes("hasAdminRole"));
  });

  it("sendError uses production-safe client messages", () => {
    const { clientMessage } = require("../utils/safeApiError");
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      assert.equal(
        clientMessage(500, 'column "foo" does not exist'),
        "The service is temporarily unavailable. Please try again shortly."
      );
      assert.equal(clientMessage(403, ""), "You do not have permission to access this resource.");
      assert.equal(clientMessage(401, ""), "Please sign in to continue.");
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it("forbidAdminOnlyCommercial guards commercial routers in app.js", () => {
    const src = fs.readFileSync(path.join(root, "src", "app.js"), "utf8");
    for (const mount of ["/api/loads", "/api/bids", "/api/profile", "/api/chat", "/api/operations"]) {
      assert.ok(
        src.includes(`app.use("${mount}", forbidAdminOnlyCommercial`),
        `missing forbidAdminOnlyCommercial on ${mount}`
      );
    }
  });
});

describe(
  "Phase 1 — live HTTP sign-off",
  { skip: integrationSuiteSkipReason() },
  () => {
    let shipperA;
    let carrierA;
    let carrierB;

    before(async () => {
      shipperA = await login(
        process.env.E2E_SHIPPER_EMAIL,
        process.env.E2E_SHIPPER_PASSWORD,
        "shipper"
      );
      carrierA = await login(
        process.env.E2E_CARRIER_EMAIL,
        process.env.E2E_CARRIER_PASSWORD,
        "carrier"
      );
      if (process.env.E2E_CARRIER2_EMAIL) {
        carrierB = await login(
          process.env.E2E_CARRIER2_EMAIL,
          process.env.E2E_CARRIER2_PASSWORD,
          "carrier"
        );
      }
    });

    it("rejects privileged body fields (mass assignment)", async () => {
      const res = await api("POST", "/api/loads", {
        token: shipperA.token,
        body: { roles: ["admin"], cargo: "x", origin: "A", destination: "B", weight: 1 }
      });
      assert.equal(res.status, 400);
    });

    it("blocks cross-user load read by id", async () => {
      const mine = await api("GET", "/api/loads/mine", { token: shipperA.token });
      const loads = Array.isArray(mine.payload) ? mine.payload : [];
      const booked = loads.find((l) => l.status && l.status !== "open");
      if (!booked) return;
      const assigned = booked.assigned_carrier_id || booked.assignedCarrierId;
      const intruder = carrierB || carrierA;
      if (assigned && String(intruder.user?.id) === String(assigned)) return;
      const res = await api("GET", `/api/loads/${booked.id}`, { token: intruder.token });
      assert.equal(res.status, 403);
    });

    it("blocks notification read for another user's id", async () => {
      const res = await api("PATCH", "/api/notifications/00000000-0000-4000-8000-000000000099/read", {
        token: carrierA.token
      });
      assert.ok([403, 404].includes(res.status));
    });

    it("role escalation via active-role fails without role on account", async () => {
      const roles = Array.isArray(carrierA.user?.roles) ? carrierA.user.roles : [];
      if (roles.includes("shipper")) return;
      const res = await api("PATCH", "/api/auth/active-role", {
        token: carrierA.token,
        body: { activeRole: "shipper" }
      });
      assert.equal(res.status, 403);
    });

    it("fresh JWT after role switch reflects DB active_role", async () => {
      const roles = Array.isArray(shipperA.user?.roles) ? shipperA.user.roles : [];
      if (!roles.includes("carrier") || !roles.includes("shipper")) return;
      const toCarrier = await api("PATCH", "/api/auth/active-role", {
        token: shipperA.token,
        body: { activeRole: "carrier" }
      });
      if (toCarrier.status !== 200) return;
      assert.equal(toCarrier.payload?.user?.activeRole, "carrier");
      const back = await api("PATCH", "/api/auth/active-role", {
        token: toCarrier.payload?.token || shipperA.token,
        body: { activeRole: "shipper" }
      });
      assert.equal(back.payload?.user?.activeRole, "shipper");
    });

    it("error JSON does not leak SQL details", async () => {
      const res = await api("PATCH", "/api/notifications/not-a-uuid/read", {
        token: carrierA.token
      });
      const body = JSON.stringify(res.data || {});
      assert.ok(!/relation|column|syntax error|postgres|node_modules/i.test(body));
    });
  }
);

describe(
  "Phase 1 — admin isolation (live)",
  { skip: skipAdminReason() },
  () => {
    let admin;

    before(async () => {
      admin = await login(
        process.env.E2E_ADMIN_EMAIL,
        process.env.E2E_ADMIN_PASSWORD,
        "admin"
      );
    });

    it("admin dashboard live is 200 with stats envelope", async () => {
      const res = await api("GET", "/api/admin/dashboard/live", { token: admin.token });
      assert.equal(res.status, 200, res.message);
      assert.ok(res.payload && typeof res.payload === "object");
    });

    it("platform admin cannot access marketplace loads list", async () => {
      const commercial = (admin.user?.roles || []).filter((r) => r === "shipper" || r === "carrier");
      if (commercial.length > 0) return;
      const res = await api("GET", "/api/loads", { token: admin.token });
      assert.equal(res.status, 403);
    });

    it("carrier cannot access admin dashboard", async () => {
      const carrier = await login(
        process.env.E2E_CARRIER_EMAIL,
        process.env.E2E_CARRIER_PASSWORD,
        "carrier"
      );
      const res = await api("GET", "/api/admin/dashboard/live", { token: carrier.token });
      assert.equal(res.status, 403);
    });
  }
);

describe("Phase 1 — production probe (optional)", () => {
  it("live API health responds without stack traces", async () => {
    const base = process.env.PHASE1_PROBE_URL || process.env.VITE_API_URL;
    if (!base) return;
    const origin = String(base).replace(/\/api\/?.*$/i, "").replace(/\/$/, "");
    const res = await fetch(`${origin}/api/health`, { cache: "no-store" });
    const json = await res.json();
    assert.equal(res.ok, true);
    const text = JSON.stringify(json);
    assert.ok(!/at\s+\w+\s+\(/i.test(text));
    assert.ok(json?.data?.version || res.headers.get("X-TransPak-Version"));
  });

  it("admin dashboard route exists on live API (401 without token, not 404)", async () => {
    const base = process.env.PHASE1_PROBE_URL || process.env.VITE_API_URL;
    if (!base) return;
    const origin = String(base).replace(/\/api\/?.*$/i, "").replace(/\/$/, "");
    const res = await fetch(`${origin}/api/admin/dashboard/live`, { cache: "no-store" });
    assert.notEqual(res.status, 404, "admin dashboard missing on deployed API");
    assert.ok([401, 403].includes(res.status), `expected 401/403 got ${res.status}`);
  });
});
