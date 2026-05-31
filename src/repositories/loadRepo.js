const { query } = require("../../db/pool");
const { distanceBetweenCities } = require("../../utils/geoDistance");

const { ACTIVE_BID_STATUSES_SQL } = require("../../utils/bidStateMachine");

const { resolveDeadlineMinutes, biddingEndsAtIso } = require("../../utils/loadDeadline");

const { OPEN_BIDDING_ELIGIBLE_SQL } = require("../../utils/loadExpiry");

const { buildCarrierMatchSql, ROUTE_PICKUP_ELIGIBLE_SQL } = require("../../utils/matchingEngine");



function resolveDistanceKm(r) {
  const stored = r.distance_km != null ? Number(r.distance_km) : null;
  if (Number.isFinite(stored) && stored > 0) return stored;
  const geo = distanceBetweenCities(r.origin ?? "", r.destination ?? "");
  return geo != null && geo > 0 ? geo : null;
}

function toLoadDto(r) {

  if (!r) return null;

  return {

    id: r.id,

    code: r.code,

    cargo: r.cargo,

    origin: r.origin,

    destination: r.destination,

    weight: r.weight != null ? Number(r.weight) : 0,

    vehicleType: r.vehicle_type ?? r.vehicleType,

    expectedPrice: r.expected_price != null ? Number(r.expected_price) : Number(r.expectedPrice ?? 0),

    suggestedFare: r.suggested_fare != null ? Number(r.suggested_fare) : null,

    distanceKm: resolveDistanceKm(r),

    pickupDate: r.pickup_date ?? r.pickupDate,

    deadlineHours: r.deadline_hours ?? r.deadlineHours,

    deadlineMinutes: resolveDeadlineMinutes(r),

    biddingEndsAt: biddingEndsAtIso(r),

    status: r.status,

    shipperId: r.shipper_id ?? r.shipperId,

    assignedCarrierId: r.assigned_carrier_id ?? r.assignedCarrierId,

    acceptedBidId: r.accepted_bid_id ?? r.acceptedBidId,

    bookingReference: r.booking_reference ?? r.bookingReference,

    createdAt: r.created_at ?? r.createdAt,

    updatedAt: r.updated_at ?? r.updatedAt,

    bidCount: r.bid_count != null ? Number(r.bid_count) : Number(r.bidCount ?? 0)

  };

}



function buildListWhere(filters = {}) {

  const {

    origin,

    destination,

    vehicleType,

    city,

    minPrice,

    maxPrice,

    minWeight,

    maxWeight,

    pickupFrom,

    pickupTo,

    excludeCarrierId = null,

    carrierFleet = null

  } = filters;



  const clauses = [`(${OPEN_BIDDING_ELIGIBLE_SQL})`, ROUTE_PICKUP_ELIGIBLE_SQL];

  const params = [];

  let i = 1;



  if (origin) {

    params.push(`%${String(origin).trim()}%`);

    clauses.push(`l.origin ILIKE $${i++}`);

  }

  if (destination) {

    params.push(`%${String(destination).trim()}%`);

    clauses.push(`l.destination ILIKE $${i++}`);

  }

  if (vehicleType) {

    params.push(`%${String(vehicleType).trim()}%`);

    clauses.push(`l.vehicle_type ILIKE $${i++}`);

  }

  if (city) {

    params.push(`%${String(city).trim()}%`);

    clauses.push(`(l.origin ILIKE $${i} OR l.destination ILIKE $${i})`);

    i++;

  }



  const minN = minPrice != null && String(minPrice).trim() !== "" ? Number(minPrice) : null;

  const maxN = maxPrice != null && String(maxPrice).trim() !== "" ? Number(maxPrice) : null;

  if (minN != null && Number.isFinite(minN)) {

    params.push(minN);

    clauses.push(`l.expected_price >= $${i++}`);

  }

  if (maxN != null && Number.isFinite(maxN)) {

    params.push(maxN);

    clauses.push(`l.expected_price <= $${i++}`);

  }



  const minW = minWeight != null && String(minWeight).trim() !== "" ? Number(minWeight) : null;

  const maxW = maxWeight != null && String(maxWeight).trim() !== "" ? Number(maxWeight) : null;

  if (minW != null && Number.isFinite(minW)) {

    params.push(minW);

    clauses.push(`l.weight >= $${i++}`);

  }

  if (maxW != null && Number.isFinite(maxW)) {

    params.push(maxW);

    clauses.push(`l.weight <= $${i++}`);

  }

  if (pickupFrom) {

    params.push(String(pickupFrom).trim());

    clauses.push(`l.pickup_date >= $${i++}::date`);

  }

  if (pickupTo) {

    params.push(String(pickupTo).trim());

    clauses.push(`l.pickup_date <= $${i++}::date`);

  }



  if (excludeCarrierId) {

    const uid = String(excludeCarrierId);

    params.push(uid);

    clauses.push(`l.shipper_id <> $${i++}`);

    params.push(uid);

    clauses.push(

      `NOT EXISTS (SELECT 1 FROM carrier_load_dismissals d WHERE d.load_id = l.id AND d.carrier_id = $${i++})`

    );

  }



  if (carrierFleet?.truckTypes?.length || carrierFleet?.maxCapacityTons > 0) {

    const match = buildCarrierMatchSql(carrierFleet, i);

    clauses.push(...match.clauses);

    params.push(...match.params);

    i = match.nextIndex;

  }



  return { clauses, params, nextIndex: i };

}



async function listOpenLoads(filters = {}) {

  const { sort = "newest", limit = 50, offset = 0 } = filters;

  const { clauses, params, nextIndex } = buildListWhere(filters);



  let orderBy = "l.created_at DESC";

  if (sort === "price_asc") orderBy = "l.expected_price ASC NULLS LAST";

  if (sort === "price_desc") orderBy = "l.expected_price DESC NULLS LAST";

  if (sort === "pickup") orderBy = "l.pickup_date ASC NULLS LAST";

  if (sort === "weight_asc") orderBy = "l.weight ASC NULLS LAST";



  const lim = Math.min(100, Math.max(1, Number(limit) || 50));

  const off = Math.max(0, Number(offset) || 0);



  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";



  const countParams = [...params];

  const { rows: countRows } = await query(

    `SELECT COUNT(*)::int AS c FROM loads l ${where}`,

    countParams

  );

  const total = countRows[0]?.c ?? 0;



  const listParams = [...params, lim, off];

  let i = nextIndex;

  const { rows } = await query(

    `SELECT l.*,

            (SELECT COUNT(*)::int FROM bids b WHERE b.load_id = l.id AND b.status IN ${ACTIVE_BID_STATUSES_SQL}) AS bid_count

     FROM loads l

     ${where}

     ORDER BY ${orderBy}

     LIMIT $${i++} OFFSET $${i++}`,

    listParams

  );



  return {

    items: rows.map(toLoadDto),

    total,

    limit: lim,

    offset: off

  };

}



module.exports = {

  toLoadDto,

  listOpenLoads,

  buildListWhere

};


