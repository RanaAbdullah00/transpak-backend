/**
 * Phase 1 — Security / ownership static checks + optional HTTP tampering.
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { hasIntegrationEnv, skipIntegrationReason } = require("./helpers/config");
const { api, login } = require("./helpers/http");

const root = path.join(__dirname, "..");

describe("Security — centralized auth helpers", () => {
  it("resourceAuth exports forbidden helpers and ownership checks", () => {
    const ra = require("../utils/resourceAuth");
    assert.equal(typeof ra.sendForbidden, "function");
    assert.equal(typeof ra.canReadLoad, "function");
    assert.equal(typeof ra.canMutateLoadAsShipper, "function");
    assert.equal(typeof ra.canMutateBidAsShipper, "function");
    assert.equal(typeof ra.sanitizePublicTrucks, "function");
  });

  it("authorizeResource middleware exists", () => {
    const m = require("../middleware/authorizeResource");
    assert.equal(typeof m.requireLoadRead, "function");
    assert.equal(typeof m.requireLoadShipperMutate, "function");
  });

  it("commercial bid routes do not use hasAdminRole", () => {
    const src = fs.readFileSync(path.join(root, "routes", "bidRoutes.js"), "utf8");
    assert.ok(!src.includes("hasAdminRole"));
    assert.ok(src.includes("canMutateBidAsShipper"));
  });

  it("canReadLoad does not grant admin bypass on commercial routes", () => {
    const src = fs.readFileSync(path.join(root, "utils", "resourceAuth.js"), "utf8");
    const fn = src.slice(src.indexOf("function canReadLoad"), src.indexOf("function canMutateLoadAsShipper"));
    assert.ok(!fn.includes("hasAdminRole"));
  });

  it("space booking carrier transitions use canActOnSpaceRequestAsCarrier", () => {
    const src = fs.readFileSync(path.join(root, "routes", "spaceBookingRoutes.js"), "utf8");
    assert.ok(src.includes("canActOnSpaceRequestAsCarrier"));
    assert.ok(src.includes("canActOnSpaceRequestAsParty"));
    assert.ok(!src.includes("hasAdminRole(req.auth)"));
  });

  it("admin routes are guarded at router level", () => {
    const src = fs.readFileSync(path.join(root, "routes", "adminRoutes.js"), "utf8");
    assert.ok(src.includes("protect") && src.includes("requireAdminSession"));
  });

  it("rejectForbiddenBodyFields is wired globally on /api", () => {
    const src = fs.readFileSync(path.join(root, "src", "app.js"), "utf8");
    assert.ok(src.includes("rejectForbiddenBodyFields"));
  });

  it("switchActiveRole does not auto-append roles (no privilege escalation)", () => {
    const src = fs.readFileSync(path.join(root, "repositories", "userRepo.js"), "utf8");
    const fn = src.slice(src.indexOf("async function switchActiveRole"));
    const end = fn.indexOf("async function upsertDemoAdmin");
    const block = end > 0 ? fn.slice(0, end) : fn.slice(0, 1200);
    assert.ok(!block.includes("unnest(COALESCE(roles"));
    assert.ok(block.includes("if (!roles.includes(role))"));
  });

  it("forbidAdminOnlyCommercial covers operations snapshot", () => {
    const src = fs.readFileSync(path.join(root, "src", "app.js"), "utf8");
    assert.ok(src.includes('app.use("/api/operations", forbidAdminOnlyCommercial'));
  });

  it("tracking socket join does not grant admin bypass", () => {
    const src = fs.readFileSync(path.join(root, "sockets", "index.js"), "utf8");
    const join = src.slice(src.indexOf("tracking:join"));
    assert.ok(!join.slice(0, 800).includes('includes("admin")'));
  });

  it("public profile sanitizes trucks", () => {
    const src = fs.readFileSync(path.join(root, "controllers", "publicProfileController.js"), "utf8");
    assert.ok(src.includes("sanitizePublicTrucks"));
  });
});

describe(
  "Security — HTTP tampering (ownership)",
  { skip: hasIntegrationEnv() ? false : skipIntegrationReason() },
  () => {
    let shipperA;
    let shipperB;
    let carrierA;

    before(async () => {
      shipperA = await login(process.env.E2E_SHIPPER_EMAIL, process.env.E2E_SHIPPER_PASSWORD, "shipper");
      shipperB = await login(
        process.env.E2E_CARRIER2_EMAIL || process.env.E2E_CARRIER_EMAIL,
        process.env.E2E_CARRIER2_PASSWORD || process.env.E2E_CARRIER_PASSWORD,
        "shipper"
      );
      carrierA = await login(process.env.E2E_CARRIER_EMAIL, process.env.E2E_CARRIER_PASSWORD, "carrier");
    });

    it("non-admin cannot access admin dashboard", async () => {
      const res = await api("GET", "/api/admin/dashboard/live", { token: carrierA.token });
      assert.equal(res.status, 403);
    });

    it("carrier cannot PATCH another user's truck (fake id)", async () => {
      const res = await api("PUT", "/api/trucks/00000000-0000-4000-8000-000000000099", {
        token: carrierA.token,
        body: { licensePlate: "HACK-001" }
      });
      assert.ok([403, 404].includes(res.status), `expected 403/404 got ${res.status}`);
    });

    it("another account cannot read private shipper load by id", async () => {
      const mine = await api("GET", "/api/loads/mine", { token: shipperA.token });
      const loads = Array.isArray(mine.payload) ? mine.payload : [];
      if (!loads.length) return;
      const loadId = loads[0].id;
      const intruder =
        shipperB.userId && String(shipperB.userId) !== String(shipperA.userId)
          ? shipperB
          : carrierA;
      const res = await api("GET", `/api/loads/${loadId}`, { token: intruder.token });
      assert.equal(res.status, 403, res.message);
    });

    it("rejects mass-assignment of shipper_id on load create", async () => {
      const res = await api("POST", "/api/loads", {
        token: shipperA.token,
        body: {
          cargo: "Test",
          origin: "Lahore",
          destination: "Karachi",
          weight: 1,
          vehicleType: "truck",
          pickupDate: "2030-01-15",
          shipper_id: "00000000-0000-4000-8000-000000000099"
        }
      });
      assert.equal(res.status, 400);
      assert.ok(String(res.message || "").includes("shipper_id") || res.code === "FORBIDDEN_FIELD");
    });

    it("carrier cannot switch active role to shipper without shipper on account", async () => {
      const roles = Array.isArray(carrierA.user?.roles) ? carrierA.user.roles : [];
      if (roles.includes("shipper")) return;
      const res = await api("PATCH", "/api/auth/active-role", {
        token: carrierA.token,
        body: { activeRole: "shipper" }
      });
      assert.equal(res.status, 403);
    });
  }
);

describe(
  "Security — HTTP tampering (admin-only commercial)",
  { skip: process.env.E2E_ADMIN_EMAIL ? false : "Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD" },
  () => {
    let adminToken;

    before(async () => {
      const admin = await login(
        process.env.E2E_ADMIN_EMAIL,
        process.env.E2E_ADMIN_PASSWORD,
        "admin"
      );
      adminToken = admin.token;
    });

    it("platform-only admin cannot list commercial loads", async () => {
      const res = await api("GET", "/api/loads", { token: adminToken });
      assert.equal(res.status, 403);
    });

    it("platform-only admin cannot access operations snapshot", async () => {
      const res = await api("GET", "/api/operations/snapshot", { token: adminToken });
      assert.equal(res.status, 403);
    });

    it("admin dashboard live returns 200 for admin session", async () => {
      const res = await api("GET", "/api/admin/dashboard/live", { token: adminToken });
      assert.equal(res.status, 200);
      assert.ok(res.payload && typeof res.payload === "object");
    });
  }
);
