/**
 * Shipment lifecycle RBAC — carrier advances; shipper closes after delivered.
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { integrationSuiteSkipReason } = require("./helpers/config");
const { api, login, createOpenLoad, placeBid, acceptBid } = require("./helpers/http");

async function bookLoad(shipper, carrier) {
  const load = await createOpenLoad(shipper.token, { cargo: `Lifecycle RBAC ${Date.now()}` });
  const bid = await placeBid(carrier.token, load.id, 120000);
  await acceptBid(shipper.token, bid.id);
  return load;
}

async function putStatus(token, loadCode, status) {
  return api("PUT", `/api/shipments/${encodeURIComponent(loadCode)}/status`, {
    token,
    body: { status }
  });
}

describe("Shipment lifecycle RBAC", { skip: integrationSuiteSkipReason(), concurrency: 1 }, () => {
  /** @type {{ token: string, user?: object }} */
  let shipper;
  /** @type {{ token: string, user?: object }} */
  let carrier;

  beforeEach(async () => {
    shipper = await login(
      process.env.E2E_SHIPPER_EMAIL,
      process.env.E2E_SHIPPER_PASSWORD,
      "shipper",
      { fresh: true }
    );
    carrier = await login(
      process.env.E2E_CARRIER_EMAIL,
      process.env.E2E_CARRIER_PASSWORD,
      "carrier",
      { fresh: true }
    );
  });

  it("carrier advances booked through delivered but cannot close", async () => {
    const load = await bookLoad(shipper, carrier);
    const ref = load.code;

    for (const step of ["pickedup", "intransit", "delivered"]) {
      const res = await putStatus(carrier.token, ref, step);
      assert.ok(res.ok, `carrier ${step}: ${res.message}`);
    }

    const closeAttempt = await putStatus(carrier.token, ref, "closed");
    assert.equal(closeAttempt.status, 403);
  });

  it("shipper cannot advance non-close statuses", async () => {
    const load = await bookLoad(shipper, carrier);
    const ref = load.code;

    const res = await putStatus(shipper.token, ref, "pickedup");
    assert.equal(res.status, 403);
  });

  it("shipper cannot close before delivered", async () => {
    const load = await bookLoad(shipper, carrier);
    const ref = load.code;

    await putStatus(carrier.token, ref, "pickedup");
    const res = await putStatus(shipper.token, ref, "closed");
    assert.equal(res.status, 400);
    assert.match(
      String(res.message || ""),
      /deliver|sequential forward/i,
      "shipper close before delivered should be rejected"
    );
  });

  it("shipper closes after carrier marks delivered", async () => {
    const load = await bookLoad(shipper, carrier);
    const ref = load.code;

    for (const step of ["pickedup", "intransit", "delivered"]) {
      await putStatus(carrier.token, ref, step);
    }

    const closeRes = await putStatus(shipper.token, ref, "closed");
    assert.ok(closeRes.ok, closeRes.message);

    const statusRes = await api("GET", `/api/shipments/${encodeURIComponent(ref)}/status`, {
      token: shipper.token
    });
    assert.ok(statusRes.ok, statusRes.message);
    assert.equal(String(statusRes.payload?.status || "").toLowerCase(), "closed");
  });
});
