/**
 * Phase 4 — centralized marketplace matching (server-side only).
 * Vehicle type, capacity, route/pickup window, fleet availability, bidding expiry.
 */
const { OPEN_BIDDING_ELIGIBLE_SQL } = require("./loadExpiry");
const { isBiddingOpen } = require("./loadDeadline");
const { getCarrierFleetProfile } = require("./loadMatching");
const { BID, normalizeBidStatus } = require("./bidStateMachine");

function normalizeVehicleType(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * In-memory fleet vs load rules (mirrors SQL constraints).
 * @param {{ truckTypes: string[], maxCapacityTons: number, truckCount: number }} fleet
 * @param {object} load
 */
function fleetMatchesLoad(fleet, load) {
  if (!fleet?.truckCount) {
    return {
      ok: false,
      status: 403,
      message: "Add at least one active truck to your fleet",
      code: "FLEET_REQUIRED"
    };
  }

  const requiredType = normalizeVehicleType(load.vehicle_type ?? load.vehicleType);
  if (requiredType) {
    const types = (fleet.truckTypes || []).map(normalizeVehicleType).filter(Boolean);
    if (!types.length || !types.includes(requiredType)) {
      return {
        ok: false,
        status: 409,
        message: "Your fleet has no truck matching this load vehicle type",
        code: "VEHICLE_TYPE_MISMATCH"
      };
    }
  }

  const loadWeight = Number(load.weight ?? 0);
  const maxCap = Number(fleet.maxCapacityTons ?? 0);
  if (loadWeight > 0 && maxCap > 0 && loadWeight > maxCap) {
    return {
      ok: false,
      status: 409,
      message: `Load weight exceeds your fleet capacity (${maxCap} tons max)`,
      code: "CAPACITY_EXCEEDED"
    };
  }

  return { ok: true };
}

/** Load is open and within bidding deadline. */
function loadIsBiddingEligible(load) {
  if (!load) return false;
  if (String(load.status || "").toLowerCase() !== "open") return false;
  return isBiddingOpen(load);
}

/** Pickup not in the past (logistics constraint). */
const ROUTE_PICKUP_ELIGIBLE_SQL = `(l.pickup_date IS NULL OR l.pickup_date >= CURRENT_DATE)`;

/**
 * SQL fragments applied for carrier marketplace listing (parameterized).
 * @param {{ truckTypes: string[], maxCapacityTons: number }} fleet
 * @param {number} startIndex - next $N index (1-based)
 */
function buildCarrierMatchSql(fleet, startIndex) {
  const clauses = [];
  const params = [];
  let i = startIndex;

  const types = [...new Set((fleet?.truckTypes || []).map((t) => normalizeVehicleType(t)).filter(Boolean))];
  if (types.length) {
    params.push(types);
    clauses.push(`lower(trim(l.vehicle_type)) = ANY($${i++}::text[])`);
  }

  const cap = fleet?.maxCapacityTons != null ? Number(fleet.maxCapacityTons) : null;
  if (cap != null && Number.isFinite(cap) && cap > 0) {
    params.push(cap);
    clauses.push(`(l.weight IS NULL OR l.weight <= $${i++})`);
  }

  clauses.push(ROUTE_PICKUP_ELIGIBLE_SQL);

  return { clauses, params, nextIndex: i };
}

/**
 * Carrier may view/bid on an open marketplace load only when matched.
 */
async function assertCarrierCanAccessLoad(carrierUserId, load) {
  const uid = String(carrierUserId || "");
  const assigned = String(load?.assigned_carrier_id ?? load?.assignedCarrierId ?? "");
  if (assigned && assigned === uid) {
    return { ok: true };
  }

  if (String(load?.shipper_id ?? load?.shipperId ?? "") === uid) {
    return { ok: true };
  }

  if (String(load?.status || "").toLowerCase() !== "open") {
    return {
      ok: false,
      status: 403,
      message: "Load is not available on the marketplace",
      code: "LOAD_NOT_AVAILABLE"
    };
  }

  if (!isBiddingOpen(load)) {
    return {
      ok: false,
      status: 409,
      message: "Bidding deadline has passed",
      code: "BID_DEADLINE_PASSED"
    };
  }

  const fleet = await getCarrierFleetProfile(uid);
  return fleetMatchesLoad(fleet, load);
}

/**
 * Full bid placement validation (open load, match, no closed bid reuse).
 */
async function validateBidPlacement({ carrierUserId, load, existingBid }) {
  if (!load) {
    return { ok: false, status: 404, message: "Not found", code: "NOT_FOUND" };
  }
  if (String(load.status) !== "open") {
    return { ok: false, status: 409, message: "Load is not open for bidding", code: "LOAD_NOT_OPEN" };
  }
  if (!isBiddingOpen(load)) {
    return { ok: false, status: 409, message: "Bidding deadline has passed", code: "BID_DEADLINE_PASSED" };
  }

  if (existingBid) {
    const st = normalizeBidStatus(existingBid.status);
    if (st === BID.ACCEPTED) {
      return {
        ok: false,
        status: 409,
        message: "This load already has an accepted carrier",
        code: "BID_ALREADY_ACCEPTED"
      };
    }
    if (st === BID.REJECTED || st === BID.CANCELLED) {
      return {
        ok: false,
        status: 409,
        message: "This bid is closed and cannot be reopened",
        code: "BID_CLOSED"
      };
    }
    if (st === BID.COUNTER || st === BID.PENDING_SHIPPER) {
      return {
        ok: false,
        status: 409,
        message: "You already have an active bid on this load — use counter-offer",
        code: "ACTIVE_BID_EXISTS"
      };
    }
  }

  const eligibility = await fleetMatchesLoad(await getCarrierFleetProfile(carrierUserId), load);
  if (!eligibility.ok) return eligibility;

  return { ok: true };
}

/**
 * Counter-offer validation — deadline unchanged; closed bids blocked.
 */
async function validateCounterBid({ actorRole, carrierUserId, bid, load }) {
  if (!bid || !load) {
    return { ok: false, status: 404, message: "Not found", code: "NOT_FOUND" };
  }

  const st = normalizeBidStatus(bid.status);
  if (st === BID.ACCEPTED || st === BID.REJECTED || st === BID.CANCELLED) {
    return {
      ok: false,
      status: 409,
      message: "Bid is closed and cannot be countered",
      code: "BID_CLOSED"
    };
  }

  if (String(load.status) !== "open") {
    return { ok: false, status: 409, message: "Load is not open for bidding", code: "LOAD_NOT_OPEN" };
  }
  if (!isBiddingOpen(load)) {
    return { ok: false, status: 409, message: "Bidding deadline has passed", code: "BID_DEADLINE_PASSED" };
  }

  if (Number(bid.counter_round_count) >= 1) {
    return {
      ok: false,
      status: 409,
      message: "Only one counter offer is allowed per bid",
      code: "COUNTER_LIMIT_REACHED"
    };
  }

  if (actorRole === "carrier") {
    const eligibility = await fleetMatchesLoad(await getCarrierFleetProfile(carrierUserId), load);
    if (!eligibility.ok) return eligibility;
  }

  return { ok: true };
}

module.exports = {
  normalizeVehicleType,
  fleetMatchesLoad,
  loadIsBiddingEligible,
  OPEN_BIDDING_ELIGIBLE_SQL,
  ROUTE_PICKUP_ELIGIBLE_SQL,
  buildCarrierMatchSql,
  assertCarrierCanAccessLoad,
  validateBidPlacement,
  validateCounterBid
};
