require('dotenv').config();
const { query, endPool } = require('../db/pool');

async function main() {
  const carrierEmail = process.env.E2E_CARRIER_ONLY_EMAIL || 'transpak.phase1.carrier@example.com';
  const shipperEmail = process.env.E2E_SHIPPER_ONLY_EMAIL || 'transpak.phase1.shipper@example.com';

  const { rows: users } = await query(
    `SELECT id, email FROM users WHERE email IN ($1, $2)`,
    [carrierEmail, shipperEmail]
  );
  const carrier = users.find((u) => u.email === carrierEmail);
  const shipper = users.find((u) => u.email === shipperEmail);
  if (!carrier || !shipper) throw new Error('users missing');

  const { rows: loads } = await query(
    `INSERT INTO loads (shipper_id, code, cargo, origin, destination, weight, vehicle_type, expected_price, pickup_date, status, deadline_minutes)
     VALUES ($1, $2, 'DIAG_LOAD', 'Lahore', 'Islamabad', 15000, 'Truck', 85000, CURRENT_DATE + 3, 'open', 480)
     RETURNING id`,
    [shipper.id, `L-DIAG${Date.now().toString().slice(-6)}`]
  );
  const loadId = loads[0].id;

  try {
    const { rows } = await query(
      `INSERT INTO bids (load_id, carrier_id, amount, status)
       VALUES ($1, $2, $3, 'pending_shipper_confirmation')
       ON CONFLICT (load_id, carrier_id) DO NOTHING
       RETURNING id`,
      [loadId, carrier.id, 82000]
    );
    console.log('INSERT OK', rows[0]?.id || 'conflict noop');
  } catch (e) {
    console.error('INSERT FAIL', e.code, e.message);
  }

  await query(`DELETE FROM bids WHERE load_id = $1`, [loadId]);
  await query(`DELETE FROM loads WHERE id = $1`, [loadId]);
  await endPool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
