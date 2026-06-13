require("dotenv").config();
const { query, endPool } = require("../db/pool");

async function main() {
  const { rows } = await query(
    `SELECT t.vehicle_type, t.status, t.plate_number
     FROM trucks t
     JOIN users u ON u.id = t.user_id
     WHERE u.email = $1`,
    [process.env.E2E_CARRIER_ONLY_EMAIL || "transpak.phase1.carrier@example.com"]
  );
  console.log("carrier trucks", rows);
  await endPool();
}

main();
