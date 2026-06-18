/**
 * 100 concurrent bid POSTs — exactly one active bid per load+carrier.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { skipConcurrencyReason } = require("./helpers/config");
const { login, createOpenLoad, placeBidRaw } = require("./helpers/http");
const { countBidsForLoadCarrier, deleteTestLoadCascade, closePool, ensureUserProfileComplete } = require("./helpers/db");

const skip = skipConcurrencyReason();

describe("Bid concurrency stress", { skip }, () => {
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
    await ensureUserProfileComplete(shipper.user?.id);
  });

  after(async () => {
    await closePool();
  });

  it("100 parallel submissions create exactly one bid row", async () => {
    const load = await createOpenLoad(shipper.token, {
      cargo: `Stress bid ${Date.now()}`,
      weight: 15000
    });
    try {
      const attempts = 100;
      const results = await Promise.all(
        Array.from({ length: attempts }, (_, i) =>
          placeBidRaw(carrier.token, load.id, 50000 + i, {
            headers: { "Idempotency-Key": `stress-${load.id}-${i % 5}` }
          })
        )
      );
      const success = results.filter((r) => r.status >= 200 && r.status < 300).length;
      assert.ok(success >= 1, "at least one bid should succeed");
      const count = await countBidsForLoadCarrier(load.id, carrier.user?.id);
      assert.equal(count, 1, `expected 1 bid row, got ${count}`);
    } finally {
      await deleteTestLoadCascade(load.id);
    }
  });
});
