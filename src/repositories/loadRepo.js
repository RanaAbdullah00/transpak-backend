const { query } = require("../../db/pool");

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
    distanceKm: r.distance_km != null ? Number(r.distance_km) : null,
    pickupDate: r.pickup_date ?? r.pickupDate,
    deadlineHours: r.deadline_hours ?? r.deadlineHours,
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

async function listOpenLoads(filters = {}) {
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
    sort = "newest",
    limit = 50,
    offset = 0
  } = filters;

  const clauses = [`l.status = 'open'`];
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

  let orderBy = "l.created_at DESC";
  if (sort === "price_asc") orderBy = "l.expected_price ASC NULLS LAST";
  if (sort === "price_desc") orderBy = "l.expected_price DESC NULLS LAST";
  if (sort === "pickup") orderBy = "l.pickup_date ASC NULLS LAST";
  if (sort === "weight_asc") orderBy = "l.weight ASC NULLS LAST";

  const lim = Math.min(100, Math.max(1, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);
  params.push(lim, off);

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await query(
    `SELECT l.*,
            (SELECT COUNT(*)::int FROM bids b WHERE b.load_id = l.id AND b.status IN ('pending','suggested')) AS bid_count
     FROM loads l
     ${where}
     ORDER BY ${orderBy}
     LIMIT $${i++} OFFSET $${i++}`,
    params
  );
  return rows.map(toLoadDto);
}

module.exports = {
  toLoadDto,
  listOpenLoads
};
