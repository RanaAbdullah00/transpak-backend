/**
 * Profile address persistence — HTTP round-trip.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { integrationSuiteSkipReason } = require("./helpers/config");
const { api, login } = require("./helpers/http");

describe("Profile address persistence", { skip: integrationSuiteSkipReason() }, () => {
  let shipper;
  const testAddress = `Test Addr ${Date.now()} Lahore PK`;

  before(async () => {
    shipper = await login(
      process.env.E2E_SHIPPER_EMAIL,
      process.env.E2E_SHIPPER_PASSWORD,
      "shipper"
    );
  });

  after(async () => {
    if (!shipper?.token) return;
    await api("PUT", "/api/profile/update", {
      token: shipper.token,
      body: { address: "" }
    });
  });

  it("PUT address then GET returns same value", async () => {
    const put = await api("PUT", "/api/profile/update", {
      token: shipper.token,
      body: { address: testAddress }
    });
    assert.ok(put.ok, put.message || `update failed ${put.status}`);
    assert.equal(put.payload?.profile?.address, testAddress);

    const get = await api("GET", "/api/profile", { token: shipper.token });
    assert.ok(get.ok);
    assert.equal(get.payload?.address, testAddress);
  });

  it("empty address clears to null", async () => {
    const put = await api("PUT", "/api/profile/update", {
      token: shipper.token,
      body: { address: "" }
    });
    assert.ok(put.ok);
    const get = await api("GET", "/api/profile", { token: shipper.token });
    assert.ok(get.ok);
    assert.ok(get.payload?.address == null || get.payload?.address === "");
  });
});
