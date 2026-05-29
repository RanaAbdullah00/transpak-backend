const { query } = require("../db/pool");
const { OPEN_BIDDING_ELIGIBLE_SQL } = require("./loadExpiry");
const { TRUCK_STATUS } = require("./truckLifecycle");
const fleetRepo = require("./fleetRepo");

/**
 * Carrier fleet profile for marketplace matching — approved trucks only.
 * @param {string} carrierUserId
 */
async function getCarrierFleetProfile(carrierUserId) {
  const uid = String(carrierUserId || "");
  if (!uid) {
    return { truckTypes: [], maxCapacityTons: 0, truckCount: 0, defaultTruck: null };
  }

  const { rows } = await query(
    `SELECT id, truck_type AS "truckType",
            COALESCE(capacity, 0)::float AS capacity,
            is_default AS "isDefault"
     FROM trucks
     WHERE user_id = $1
       AND status = $2
       AND char_length(trim(coalesce(truck_type, ''))) > 0`,
    [uid, TRUCK_STATUS.APPROVED]
  );

  const truckTypes = [...new Set(rows.map((r) => String(r.truckType || "").trim()).filter(Boolean))];
  const maxCapacityTons = rows.reduce((m, r) => Math.max(m, Number(r.capacity) || 0), 0);
  const defaultRow =
    rows.find((r) => r.isDefault) ||
    rows[0] ||
    null;

  let defaultTruck = null;
  if (defaultRow) {
    defaultTruck = {
      id: defaultRow.id,
      truckType: defaultRow.truckType,
      capacity: Number(defaultRow.capacity) || 0
    };
  }

  return {
    truckTypes,
    maxCapacityTons,
    truckCount: rows.length,
    defaultTruck
  };
}

module.exports = {
  OPEN_BIDDING_ELIGIBLE_SQL,
  getCarrierFleetProfile,
  ensureDefaultTruck: fleetRepo.ensureDefaultTruck
};
