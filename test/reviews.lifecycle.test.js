/**
 * Reviews lifecycle — closed-shipment gate and pending contract.
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { integrationSuiteSkipReason } = require("./helpers/config");
const { api, login, createOpenLoad } = require("./helpers/http");

describe("Reviews lifecycle", { skip: integrationSuiteSkipReason() }, () => {
  let shipper;
  let carrier;

  before(async () => {
    shipper = await login(
      process.env.E2E_SHIPPER_EMAIL,
      process.env.E2E_SHIPPER_PASSWORD,
      "shipper"
    );
    carrier = await login(
      process.env.E2E_CARRIER_EMAIL,
      process.env.E2E_CARRIER_PASSWORD,
      "carrier"
    );
  });

  it("GET /reviews/pending returns array envelope", async () => {
    const res = await api("GET", "/api/reviews/pending", { token: shipper.token });
    assert.ok(res.ok, res.message);
    assert.ok(Array.isArray(res.payload));
  });

  it("POST /reviews rejects review before shipment closed", async () => {
    const load = await createOpenLoad(shipper.token, { cargo: `Review lifecycle ${Date.now()}` });
    const bid = await api("POST", "/api/bids", {
      token: carrier.token,
      body: { loadId: load.id, amount: 100000 }
    });
    if (!bid.ok || !bid.payload?.id) return;
    await api("PUT", `/api/bids/${bid.payload.id}/accept`, { token: shipper.token });

    const res = await api("POST", "/api/reviews", {
      token: shipper.token,
      body: {
        toUser: carrier.user?.id,
        rating: 5,
        comment: "Too early",
        loadId: load.id
      }
    });
    assert.equal(res.status, 409);
    assert.match(String(res.message || ""), /closed/i);
  });

  it("POST /reviews rejects self-review", async () => {
    const res = await api("POST", "/api/reviews", {
      token: shipper.token,
      body: {
        toUser: shipper.user?.id,
        rating: 5,
        loadId: "00000000-0000-4000-8000-000000000099"
      }
    });
    assert.equal(res.status, 400);
  });
});
