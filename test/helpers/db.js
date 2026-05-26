const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { query, getPool } = require("../../db/pool");

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  );
}

/**
 * Insert a minimal open load for expiry / DB tests.
 * @param {string} shipperId
 * @param {{ status?: string, deadlineMinutes?: number, createdAtOffsetHours?: number }} [opts]
 */
async function insertTestLoad(shipperId, opts = {}) {
  const status = opts.status || "open";
  const deadlineMinutes = opts.deadlineMinutes ?? 60;
  const offsetH = opts.createdAtOffsetHours ?? -3;
  const code = `TST-${Date.now().toString(36).toUpperCase()}`;
  const pickup = new Date();
  pickup.setUTCDate(pickup.getUTCDate() + 5);
  const pickupDate = pickup.toISOString().slice(0, 10);

  const { rows } = await query(
    `INSERT INTO loads
       (code, shipper_id, cargo, origin, destination, weight, vehicle_type, expected_price,
        pickup_date, deadline_hours, deadline_minutes, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'Lahore', 'Karachi', 10, 'Truck', 50000, $4::date, 1, $5, $6,
             now() + ($7::text || ' hours')::interval, now())
     RETURNING id, code, status, deadline_minutes AS "deadlineMinutes", created_at AS "createdAt"`,
    [code, shipperId, `expiry-test-${code}`, pickupDate, deadlineMinutes, status, String(offsetH)]
  );
  return rows[0];
}

async function insertTestBid(loadId, carrierId, status = "pending_shipper_confirmation") {
  const { rows } = await query(
    `INSERT INTO bids (load_id, carrier_id, amount, status)
     VALUES ($1, $2, 100000, $3)
     ON CONFLICT (load_id, carrier_id)
     DO UPDATE SET status = EXCLUDED.status, updated_at = now()
     RETURNING id, load_id AS "loadId", carrier_id AS "carrierId", status`,
    [loadId, carrierId, status]
  );
  return rows[0];
}

async function countShipmentsForLoad(loadId) {
  const { rows } = await query(`SELECT COUNT(*)::int AS c FROM shipments WHERE load_id = $1`, [loadId]);
  return rows[0]?.c ?? 0;
}

async function countAcceptedBidsForLoad(loadId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS c FROM bids WHERE load_id = $1 AND status = 'accepted'`,
    [loadId]
  );
  return rows[0]?.c ?? 0;
}

async function getLoadStatus(loadId) {
  const { rows } = await query(`SELECT status, accepted_bid_id FROM loads WHERE id = $1`, [loadId]);
  return rows[0] || null;
}

async function deleteTestLoadCascade(loadId) {
  if (!isUuid(loadId)) return;
  await query(`DELETE FROM shipment_events WHERE shipment_id IN (SELECT id FROM shipments WHERE load_id = $1)`, [
    loadId
  ]);
  await query(`DELETE FROM shipments WHERE load_id = $1`, [loadId]);
  await query(`DELETE FROM bookings WHERE load_id = $1`, [loadId]);
  await query(`DELETE FROM bids WHERE load_id = $1`, [loadId]);
  await query(`DELETE FROM loads WHERE id = $1`, [loadId]);
}

async function findUserIdByEmail(email) {
  const { rows } = await query(
    `SELECT id, email, roles FROM users WHERE lower(trim(email)) = lower(trim($1)) LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}

async function closePool() {
  const pool = getPool();
  if (pool && typeof pool.end === "function") {
    await pool.end();
  }
}

module.exports = {
  query,
  isUuid,
  insertTestLoad,
  insertTestBid,
  countShipmentsForLoad,
  countAcceptedBidsForLoad,
  getLoadStatus,
  deleteTestLoadCascade,
  findUserIdByEmail,
  closePool
};
