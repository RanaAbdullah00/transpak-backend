const { query } = require("../db/pool");

async function closeExpiredCapacityListings() {
  await query(
    `UPDATE carrier_space_listings
     SET status = 'closed', updated_at = now()
     WHERE status = 'open'
       AND (
         (available_from IS NOT NULL AND available_from < CURRENT_DATE)
         OR EXISTS (
           SELECT 1
           FROM jsonb_array_elements(COALESCE(availability_slots, '[]'::jsonb)) elem
           WHERE elem->>'type' = 'visibility'
             AND elem->>'visibleUntil' IS NOT NULL
             AND (elem->>'visibleUntil')::timestamptz < now()
         )
       )`
  );
}

module.exports = { closeExpiredCapacityListings };
