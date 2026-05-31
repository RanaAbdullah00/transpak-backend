const { persistLoadRouteSnapshot } = require("./loadRouteSnapshot");

function generateCapacityLoadCode() {
  return `C-${Math.floor(100000 + Math.random() * 900000)}`;
}

/**
 * Create load + booking + shipment for an accepted capacity request (same engine as bid accept).
 * @param {import('pg').PoolClient} client
 * @param {{ id: string, shipper_id: string, requested_kg: number, message?: string|null }} requestRow
 * @param {{ carrier_id: string, origin: string, destination: string, vehicle_type?: string, rate_per_kg?: number|null, available_from?: string|null }} listing
 * @returns {Promise<{ loadId: string, loadCode: string, bookingId: string, shipmentId: string }>}
 */
async function createShipmentFromCapacityAccept(client, requestRow, listing) {
  const code = generateCapacityLoadCode();
  const weight = Number(requestRow.requested_kg) || 0;
  const rate = listing.rate_per_kg != null ? Number(listing.rate_per_kg) : 0;
  const price = rate > 0 && weight > 0 ? Math.round(rate * weight) : 0;
  const pickupDate =
    listing.available_from && /^\d{4}-\d{2}-\d{2}$/.test(String(listing.available_from).slice(0, 10))
      ? String(listing.available_from).slice(0, 10)
      : new Date().toISOString().slice(0, 10);
  const cargo = requestRow.message
    ? String(requestRow.message).trim().slice(0, 200)
    : "Capacity booking";
  const vehicleType = String(listing.vehicle_type || "Truck").trim();
  const origin = String(listing.origin || "").trim();
  const destination = String(listing.destination || "").trim();
  const bookingRef = `space:${requestRow.id}`;

  const { rows: loadRows } = await client.query(
    `INSERT INTO loads
       (code, shipper_id, cargo, origin, destination, weight, vehicle_type, expected_price,
        pickup_date, deadline_hours, deadline_minutes, status, assigned_carrier_id, booking_reference,
        pickup_location, drop_location)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, 48, 2880, 'booked', $10, $11, $4, $5)
     RETURNING id, code`,
    [
      code,
      requestRow.shipper_id,
      cargo,
      origin,
      destination,
      weight,
      vehicleType,
      price,
      pickupDate,
      listing.carrier_id,
      bookingRef
    ]
  );
  const loadId = loadRows[0].id;
  const loadCode = loadRows[0].code;

  const { rows: bookingRows } = await client.query(
    `INSERT INTO bookings (load_id, shipper_id, carrier_id, status, price)
     VALUES ($1, $2, $3, 'approved', $4)
     RETURNING id`,
    [loadId, requestRow.shipper_id, listing.carrier_id, price]
  );
  const bookingId = bookingRows[0].id;

  const { rows: shipRows } = await client.query(
    `INSERT INTO shipments (load_id, booking_id, status, location_unavailable)
     VALUES ($1, $2, 'booked', true)
     RETURNING id`,
    [loadId, bookingId]
  );
  const shipmentId = shipRows[0].id;

  await client.query(
    `INSERT INTO shipment_events (shipment_id, status, note, location_label)
     VALUES ($1, 'booked', 'Capacity contract accepted', 'System')`,
    [shipmentId]
  );

  await client.query(
    `UPDATE carrier_space_requests SET load_id = $2, updated_at = now() WHERE id = $1`,
    [requestRow.id, loadId]
  );

  void persistLoadRouteSnapshot(loadId, origin, destination).catch(() => {});

  return { loadId, loadCode, bookingId, shipmentId };
}

module.exports = { createShipmentFromCapacityAccept, generateCapacityLoadCode };
