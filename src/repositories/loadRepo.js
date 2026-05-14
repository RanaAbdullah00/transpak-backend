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
  const { origin, destination, vehicleType, city, minPrice, maxPrice } = filters;
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

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await query(
    `SELECT l.*,
            (SELECT COUNT(*)::int FROM bids b WHERE b.load_id = l.id AND b.status IN ('pending','suggested')) AS bid_count
     FROM loads l
     ${where}
     ORDER BY l.created_at DESC
     LIMIT 200`,
    params
  );
  return rows.map(toLoadDto);
}

module.exports = {
  toLoadDto,
  listOpenLoads
};

