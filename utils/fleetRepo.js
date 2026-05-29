const { query } = require("../db/pool");
const { TRUCK_STATUS } = require("./truckLifecycle");

function mapTruckRow(r) {
  if (!r) return null;
  return r;
}

async function findDuplicate({ licensePlate, engineNumber, chassisNumber, excludeId = null }) {
  const plate = String(licensePlate || "").trim();
  const engine = String(engineNumber || "").trim();
  const chassis = String(chassisNumber || "").trim();
  const params = [plate, engine, chassis];
  let exclude = "";
  if (excludeId) {
    params.push(String(excludeId));
    exclude = `AND id <> $${params.length}`;
  }
  const { rows } = await query(
    `SELECT id, user_id FROM trucks
     WHERE (
       ($1 <> '' AND lower(trim(license_plate)) = lower(trim($1)))
       OR ($2 <> '' AND lower(trim(engine_number)) = lower(trim($2)))
       OR ($3 <> '' AND chassis_number IS NOT NULL AND lower(trim(chassis_number)) = lower(trim($3)))
     )
     ${exclude}
     LIMIT 1`,
    params
  );
  return rows[0] || null;
}

async function countTrucks(userId, { status = null } = {}) {
  const params = [String(userId)];
  let clause = "";
  if (status) {
    params.push(status);
    clause = `AND status = $${params.length}`;
  }
  const { rows } = await query(
    `SELECT COUNT(*)::int AS c FROM trucks WHERE user_id = $1 ${clause}`,
    params
  );
  return rows[0]?.c || 0;
}

async function countApprovedTrucks(userId) {
  return countTrucks(userId, { status: TRUCK_STATUS.APPROVED });
}

async function listTrucksByUser(userId, { page = 1, pageSize = 20 } = {}) {
  const lim = Math.min(50, Math.max(5, Number(pageSize) || 20));
  const pg = Math.max(1, Number(page) || 1);
  const offset = (pg - 1) * lim;
  const uid = String(userId);
  const { rows: countRows } = await query(`SELECT COUNT(*)::int AS c FROM trucks WHERE user_id = $1`, [uid]);
  const total = countRows[0]?.c || 0;
  const { rows } = await query(
    `SELECT id, engine_number AS "engineNumber", truck_type AS "truckType", capacity,
            license_plate AS "licensePlate", chassis_number AS "chassisNumber",
            status, is_default AS "isDefault",
            truck_card_front_image AS "truckCardFrontImage",
            truck_card_back_image AS "truckCardBackImage",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM trucks
     WHERE user_id = $1
     ORDER BY is_default DESC, created_at DESC
     LIMIT $2 OFFSET $3`,
    [uid, lim, offset]
  );
  return { items: rows.map(mapTruckRow), total, page: pg, pageSize: lim };
}

async function getTruckById(id) {
  const { rows } = await query(`SELECT * FROM trucks WHERE id = $1`, [String(id)]);
  return rows[0] || null;
}

async function setDefaultTruck(userId, truckId) {
  const uid = String(userId);
  const tid = String(truckId);
  await query(`UPDATE trucks SET is_default = false, updated_at = now() WHERE user_id = $1`, [uid]);
  const { rows } = await query(
    `UPDATE trucks SET is_default = true, updated_at = now()
     WHERE id = $1 AND user_id = $2 AND status = $3
     RETURNING id`,
    [tid, uid, TRUCK_STATUS.APPROVED]
  );
  return rows[0] || null;
}

/** If no default among approved trucks, promote the newest approved. */
async function ensureDefaultTruck(userId) {
  const uid = String(userId);
  const { rows: current } = await query(
    `SELECT id FROM trucks
     WHERE user_id = $1 AND status = $2 AND is_default = true
     LIMIT 1`,
    [uid, TRUCK_STATUS.APPROVED]
  );
  if (current[0]) return current[0].id;

  const { rows: pick } = await query(
    `SELECT id FROM trucks
     WHERE user_id = $1 AND status = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [uid, TRUCK_STATUS.APPROVED]
  );
  if (!pick[0]) return null;
  await setDefaultTruck(uid, pick[0].id);
  return pick[0].id;
}

async function listTrucksAdmin({ status = TRUCK_STATUS.PENDING, page = 1, pageSize = 25 } = {}) {
  const lim = Math.min(100, Math.max(5, Number(pageSize) || 25));
  const pg = Math.max(1, Number(page) || 1);
  const offset = (pg - 1) * lim;
  const st = String(status || TRUCK_STATUS.PENDING).toLowerCase();
  const { rows: countRows } = await query(`SELECT COUNT(*)::int AS c FROM trucks WHERE status = $1`, [st]);
  const total = countRows[0]?.c || 0;
  const { rows } = await query(
    `SELECT t.id, t.user_id AS "carrierId", t.engine_number AS "engineNumber",
            t.truck_type AS "truckType", t.capacity, t.license_plate AS "licensePlate",
            t.chassis_number AS "chassisNumber", t.status, t.is_default AS "isDefault",
            t.truck_card_front_image AS "truckCardFrontImage",
            t.truck_card_back_image AS "truckCardBackImage",
            t.created_at AS "createdAt",
            COALESCE(u.full_name, u.email, 'Carrier') AS "carrierName",
            u.email AS "carrierEmail"
     FROM trucks t
     JOIN users u ON u.id = t.user_id
     WHERE t.status = $1
     ORDER BY t.created_at ASC
     LIMIT $2 OFFSET $3`,
    [st, lim, offset]
  );
  return { items: rows, total, page: pg, pageSize: lim };
}

async function updateTruckStatus(truckId, status) {
  const { rows } = await query(
    `UPDATE trucks SET status = $2, updated_at = now() WHERE id = $1
     RETURNING id, user_id, status, is_default AS "isDefault"`,
    [String(truckId), String(status)]
  );
  return rows[0] || null;
}

module.exports = {
  findDuplicate,
  countTrucks,
  countApprovedTrucks,
  listTrucksByUser,
  getTruckById,
  setDefaultTruck,
  ensureDefaultTruck,
  listTrucksAdmin,
  updateTruckStatus
};
