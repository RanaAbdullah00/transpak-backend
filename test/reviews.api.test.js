/**
 * Phase 2 — Reviews API + carrier capacity RBAC smoke.
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { hasIntegrationEnv, skipIntegrationReason } = require("./helpers/config");
const { api, login, healthCheck } = require("./helpers/http");

const shipperEmail = () => process.env.E2E_SHIPPER_EMAIL;
const shipperPass = () => process.env.E2E_SHIPPER_PASSWORD;
const carrierEmail = () => process.env.E2E_CARRIER_EMAIL;
const carrierPass = () => process.env.E2E_CARRIER_PASSWORD;

describe("Reviews API", { skip: hasIntegrationEnv() ? false : skipIntegrationReason() }, () => {
  /** @type {{ token: string, user: object }} */
  let shipper;
  /** @type {{ token: string, user: object }} */
  let carrier;

  before(async () => {
    const health = await healthCheck();
    assert.equal(health.data?.success, true);
    shipper = await login(shipperEmail(), shipperPass(), "shipper");
    carrier = await login(carrierEmail(), carrierPass(), "carrier");
  });

  it("GET /reviews/pending returns array with avatar field contract", async () => {
    const res = await api("GET", "/api/reviews/pending", { token: shipper.token });
    assert.ok(res.ok, res.message);
    assert.equal(res.data?.success, true);
    assert.ok(Array.isArray(res.payload));
    for (const row of res.payload) {
      assert.ok("toUserAvatar" in row, "pending rows must include toUserAvatar");
      assert.ok("toUserRole" in row, "pending rows must include toUserRole");
    }
  });

  it("GET /reviews/:userId returns persisted summary envelope", async () => {
    const targetId = carrier.user?.id || shipper.user?.id;
    assert.ok(targetId);
    const res = await api("GET", `/api/reviews/${targetId}`, { token: shipper.token });
    assert.ok(res.ok, res.message);
    assert.equal(res.data?.success, true);
    assert.equal(typeof res.payload?.ratingAverage, "number");
    assert.equal(typeof res.payload?.ratingCount, "number");
    assert.ok(Array.isArray(res.payload?.reviews));
  });
});

describe("Carrier capacity RBAC", { skip: hasIntegrationEnv() ? false : skipIntegrationReason() }, () => {
  /** @type {{ token: string }} */
  let carrier;
  /** @type {{ token: string }} */
  let shipper;

  before(async () => {
    carrier = await login(carrierEmail(), carrierPass(), "carrier");
    shipper = await login(shipperEmail(), shipperPass(), "shipper");
  });

  it("GET /carrier-space rejects carrier workspace tokens", async () => {
    const res = await api("GET", "/api/carrier-space", { token: carrier.token, workspace: "carrier" });
    assert.equal(res.status, 403);
  });

  it("GET /carrier-space allows shipper browse", async () => {
    const res = await api("GET", "/api/carrier-space", { token: shipper.token, workspace: "shipper" });
    assert.ok(res.ok, res.message);
    assert.equal(res.data?.success, true);
    assert.ok(Array.isArray(res.payload));
  });
});
