/**
 * Phase 3 — Concurrent shipper accept of two bids on one open load.
 * (Only one booking + one accepted bid + one shipment row.)
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { skipConcurrencyReason } = require("./helpers/config");
const { login, createOpenLoad, placeBid, acceptBid } = require("./helpers/http");
const {
  countShipmentsForLoad,
  countAcceptedBidsForLoad,
  getLoadStatus,
  deleteTestLoadCascade
} = require("./helpers/db");

describe("Bid accept concurrency", { skip: skipConcurrencyReason() }, () => {
  let shipper;
  let carrier1;
  let carrier2;
  let load;
  let bid1;
  let bid2;

  before(async () => {
    shipper = await login(
      process.env.E2E_SHIPPER_EMAIL,
      process.env.E2E_SHIPPER_PASSWORD,
      "shipper"
    );
    carrier1 = await login(
      process.env.E2E_CARRIER_EMAIL,
      process.env.E2E_CARRIER_PASSWORD,
      "carrier"
    );
    carrier2 = await login(
      process.env.E2E_CARRIER2_EMAIL,
      process.env.E2E_CARRIER2_PASSWORD,
      "carrier"
    );
    load = await createOpenLoad(shipper.token, {
      cargo: `Concurrency load ${Date.now()}`
    });
    bid1 = await placeBid(carrier1.token, load.id, 140000);
    bid2 = await placeBid(carrier2.token, load.id, 141000);
  });

  after(async () => {
    if (load?.id) await deleteTestLoadCascade(load.id);
  });

  it("only one parallel accept succeeds; second is rejected safely", async () => {
    const [a, b] = await Promise.all([
      acceptBid(shipper.token, bid1.id),
      acceptBid(shipper.token, bid2.id)
    ]);

    const successes = [a, b].filter((r) => r.ok);
    const conflicts = [a, b].filter(
      (r) => r.status === 409 || r.code === "LOAD_ALREADY_BOOKED" || r.code === "LOAD_NOT_OPEN"
    );

    assert.equal(successes.length, 1, `expected 1 accept success, got ${JSON.stringify([a, b])}`);
    assert.ok(conflicts.length >= 1, "second accept should be rejected with conflict");

    const acceptedCount = await countAcceptedBidsForLoad(load.id);
    assert.equal(acceptedCount, 1);

    const shipmentCount = await countShipmentsForLoad(load.id);
    assert.equal(shipmentCount, 1);

    const loadRow = await getLoadStatus(load.id);
    assert.equal(loadRow.status, "booked");
    assert.ok(loadRow.accepted_bid_id);
  });
});
