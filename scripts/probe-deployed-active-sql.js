require("dotenv").config();
const { query, endPool } = require("../db/pool");

const CARRIER = process.env.E2E_CARRIER_ONLY_EMAIL || "transpak.phase1.carrier@example.com";

async function main() {
  const { rows: users } = await query(`SELECT id FROM users WHERE email = $1`, [CARRIER]);
  const uid = users[0]?.id;
  console.log("uid", uid);

  const deployedSql = `
    SELECT l.id, l.code, l.cargo, l.origin, l.destination,
           l.vehicle_type AS "vehicleType", l.pickup_date AS "pickupDate",
           l.shipper_id AS "shipperId", l.assigned_carrier_id AS "assignedCarrierId",
           s.id AS "shipmentId", s.status AS "shipmentStatus", s.updated_at AS "updatedAt",
           CASE
             WHEN l.booking_reference IS NOT NULL AND l.booking_reference LIKE 'space:%'
             THEN 'CAPACITY'
             ELSE 'BID'
           END AS "flowType",
           CASE
             WHEN s.status NOT IN ('delivered', 'closed', 'completed')
             THEN true
             ELSE false
           END AS "trackingEnabled"
    FROM shipments s
    JOIN loads l ON l.id = s.load_id
    WHERE s.status NOT IN ('delivered', 'closed')
      AND l.status = 'booked'
      AND (l.shipper_id = $1 OR l.assigned_carrier_id = $1)
    ORDER BY s.updated_at DESC
    LIMIT 50`;

  try {
    const r = await query(deployedSql, [uid]);
    console.log("deployed SQL OK rows", r.rows.length);
  } catch (e) {
    console.log("deployed SQL FAIL", e.message, e.code);
  }

  await endPool();
}

main();
