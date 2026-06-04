const { query } = require("../db/pool");

/**
 * Close open listings past available_from (marketplace hygiene, no schema change).
 */
async function closeExpiredCapacityListings() {
  await query(
    `UPDATE carrier_space_listings
     SET status = 'closed', updated_at = now()
     WHERE status = 'open'
       AND available_from IS NOT NULL
       AND available_from < CURRENT_DATE`
  );
}

module.exports = { closeExpiredCapacityListings };
