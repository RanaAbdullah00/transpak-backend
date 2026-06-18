/**
 * Phase 2 — RBAC and self-exclusion (HTTP).
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { integrationSuiteSkipReason, getE2ECredentials } = require("./helpers/config");
const { api, login, createOpenLoad } = require("./helpers/http");

describe("RBAC safety", { skip: integrationSuiteSkipReason() }, () => {
  let shipper;
  let carrier;
  let ownLoad;

  before(async () => {
    const creds = getE2ECredentials();
    shipper = await login(creds.shipperEmail, creds.shipperPassword, "shipper");
    carrier = await login(creds.carrierEmail, creds.carrierPassword, "carrier");
    ownLoad = await createOpenLoad(shipper.token, {
      cargo: `RBAC self-exclusion ${Date.now()}`
    });
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await api("GET", "/api/profile");
    assert.equal(res.status, 401);
    assert.equal(res.data?.success, false);
    assert.ok(res.code || res.message);
  });

  it("carrier cannot post loads (shipper-only mutation)", async () => {
    const res = await api("POST", "/api/loads/create", {
      token: carrier.token,
      body: {
        cargo: "blocked",
        origin: "Lahore",
        destination: "Karachi",
        weight: 10,
        vehicleType: "Truck",
        expectedPrice: 100000,
        pickupDate: new Date(Date.now() + 86400000 * 4).toISOString().slice(0, 10),
        deadlineMinutes: 120
      }
    });
    assert.equal(res.status, 403);
    assert.equal(res.code, "FORBIDDEN_ROLE");
  });

  it("carrier cannot access admin routes", async () => {
    const res = await api("GET", "/api/admin/dashboard/live", { token: carrier.token });
    assert.equal(res.status, 403);
    assert.equal(res.data?.success, false);
  });

  it("rejects invalid viewAs with 400", async () => {
    const res = await api("GET", "/api/bids", {
      token: carrier.token,
      query: { viewAs: "not-a-role" }
    });
    assert.equal(res.status, 400);
    assert.equal(res.code, "INVALID_VIEW_AS");
  });

  it("rejects viewAs role not held by user", async () => {
    const roles = carrier.user?.roles || [];
    if (roles.includes("shipper")) {
      return; // skip — account has both roles
    }
    const res = await api("GET", "/api/bids", {
      token: carrier.token,
      query: { viewAs: "shipper" }
    });
    assert.equal(res.status, 403);
    assert.equal(res.code, "FORBIDDEN_VIEW_AS");
  });

  it("blocks same-account self marketplace bid", async () => {
    const roles = shipper.user?.roles || [];
    if (!roles.includes("carrier")) {
      return; // need dual-role test account; set roles on E2E shipper in DB
    }
    const asCarrier = await login(
      process.env.E2E_SHIPPER_EMAIL,
      process.env.E2E_SHIPPER_PASSWORD,
      "carrier"
    );
    const res = await api("POST", "/api/bids", {
      token: asCarrier.token,
      body: { loadId: ownLoad.id, amount: 120000 }
    });
    assert.ok([403, 409].includes(res.status) || res.code === "TRUCK_REQUIRED", `got ${res.status} ${res.code}`);
  });
});
