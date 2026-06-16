/**
 * Capacity listing expiry — scheduler closes past visibility.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { hasDatabaseUrl, skipDbReason } = require("./helpers/config");
const { query, closePool, findUserIdByEmail } = require("./helpers/db");
const { closeExpiredCapacityListings } = require("../utils/capacityListingLifecycle");

function skipReason() {
  if (!hasDatabaseUrl()) return skipDbReason();
  const email =
    process.env.E2E_CARRIER_EMAIL || process.env.TEST_CARRIER_EMAIL || process.env.SEED_CARRIER_EMAIL;
  if (!email) return "Set E2E_CARRIER_EMAIL for capacity expiry tests";
  return false;
}

describe("Capacity expiry integration", { skip: skipReason() }, () => {
  /** @type {string} */
  let carrierId;
  /** @type {string[]} */
  const listingIds = [];

  before(async () => {
    const email =
      process.env.E2E_CARRIER_EMAIL || process.env.TEST_CARRIER_EMAIL || process.env.SEED_CARRIER_EMAIL;
    const user = await findUserIdByEmail(email);
    assert.ok(user?.id);
    carrierId = user.id;
  });

  after(async () => {
    for (const id of listingIds) {
      await query(`DELETE FROM carrier_space_listings WHERE id = $1`, [id]).catch(() => {});
    }
    await closePool();
  });

  it("closes listing when visibility slot is in the past", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const { rows } = await query(
      `INSERT INTO carrier_space_listings
         (carrier_id, origin, destination, truck_capacity_kg, remaining_space_kg,
          vehicle_type, rate_per_kg, status, availability_slots)
       VALUES ($1, 'Lahore', 'Karachi', 20000, 20000, 'Truck', 5, 'open',
         $2::jsonb)
       RETURNING id`,
      [
        carrierId,
        JSON.stringify([{ type: "visibility", visibleUntil: past }])
      ]
    );
    const id = rows[0].id;
    listingIds.push(id);

    await closeExpiredCapacityListings();

    const { rows: after } = await query(`SELECT status FROM carrier_space_listings WHERE id = $1`, [id]);
    assert.equal(after[0].status, "closed");
  });
});
