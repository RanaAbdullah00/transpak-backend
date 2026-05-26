/**
 * Phase 4 — Marketplace expiry processor (direct DB, no HTTP).
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { hasDatabaseUrl, skipDbReason } = require("./helpers/config");
const {
  insertTestLoad,
  insertTestBid,
  deleteTestLoadCascade,
  findUserIdByEmail,
  closePool
} = require("./helpers/db");
const {
  expireStaleOpenLoads,
  expireBidsOnNonOpenLoads,
  runMarketplaceExpiryProcessor
} = require("../utils/loadExpiry");

function skipExpiryReason() {
  if (!hasDatabaseUrl()) return skipDbReason();
  const email =
    process.env.E2E_SHIPPER_EMAIL || process.env.TEST_SHIPPER_EMAIL || process.env.SEED_SHIPPER_EMAIL;
  if (!email) return "Set E2E_SHIPPER_EMAIL (or TEST_SHIPPER_EMAIL) for expiry tests";
  return false;
}

describe("Marketplace expiry", { skip: skipExpiryReason() }, () => {
  /** @type {string} */
  let shipperId;
  /** @type {string|null} */
  let carrierId;
  const loadIds = [];

  before(async () => {
    const email =
      process.env.E2E_SHIPPER_EMAIL || process.env.TEST_SHIPPER_EMAIL || process.env.SEED_SHIPPER_EMAIL;
    const user = await findUserIdByEmail(email);
    assert.ok(user?.id, `No user for ${email}`);
    shipperId = user.id;

    const carrierEmail =
      process.env.E2E_CARRIER_EMAIL || process.env.TEST_CARRIER_EMAIL || process.env.SEED_CARRIER_EMAIL;
    if (carrierEmail) {
      const c = await findUserIdByEmail(carrierEmail);
      carrierId = c?.id || null;
    }
  });

  after(async () => {
    for (const id of loadIds) {
      await deleteTestLoadCascade(id);
    }
    await closePool();
  });

  it("expires stale open loads past deadline", async () => {
    const row = await insertTestLoad(shipperId, {
      status: "open",
      deadlineMinutes: 30,
      createdAtOffsetHours: -5
    });
    loadIds.push(row.id);

    const n = await expireStaleOpenLoads();
    assert.ok(n >= 1);

    const { query } = require("./helpers/db");
    const { rows } = await query(`SELECT status FROM loads WHERE id = $1`, [row.id]);
    assert.equal(rows[0].status, "cancelled");
  });

  it("does not expire booked loads even when created long ago", async () => {
    const row = await insertTestLoad(shipperId, {
      status: "booked",
      deadlineMinutes: 1,
      createdAtOffsetHours: -48
    });
    loadIds.push(row.id);

    await expireStaleOpenLoads();
    const { query } = require("./helpers/db");
    const { rows } = await query(`SELECT status FROM loads WHERE id = $1`, [row.id]);
    assert.equal(rows[0].status, "booked");
  });

  it("cancels active bids when load is no longer open", async () => {
    if (!carrierId) {
      return; // optional carrier id
    }
    const row = await insertTestLoad(shipperId, { status: "cancelled", deadlineMinutes: 60 });
    loadIds.push(row.id);
    const bid = await insertTestBid(row.id, carrierId, "pending_shipper_confirmation");

    const n = await expireBidsOnNonOpenLoads();
    assert.ok(n >= 1);

    const { query } = require("./helpers/db");
    const { rows } = await query(`SELECT status FROM bids WHERE id = $1`, [bid.id]);
    assert.equal(rows[0].status, "cancelled");
  });

  it("runMarketplaceExpiryProcessor returns counts object", async () => {
    const result = await runMarketplaceExpiryProcessor();
    assert.ok(typeof result.loadsExpired === "number");
    assert.ok(typeof result.bidsExpired === "number");
  });
});
