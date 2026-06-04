const { query } = require("../db/pool");

/**
 * Single shipment row bootstrap — preserves per-caller SQL semantics (no workflow change).
 * @param {import('pg').PoolClient|{query:Function}|null} client
 * @param {{
 *   loadId: string,
 *   bookingId?: string|null,
 *   mode: 'posted_placeholder'|'posted_gps'|'get_or_create'|'booked_upsert'|'booked_insert',
 *   locationUnavailable?: boolean
 * }} opts
 */
async function createShipmentUnified(client, opts) {
  const loadId = opts?.loadId;
  const bookingId = opts?.bookingId ?? null;
  const mode = opts?.mode || "get_or_create";
  const locUnavailable = opts?.locationUnavailable !== false;

  if (!loadId) throw new Error("loadId required");

  const run = (text, params) => {
    if (client && typeof client.query === "function") return client.query(text, params);
    return query(text, params);
  };

  if (mode === "posted_placeholder") {
    await run(
      `INSERT INTO shipments (load_id, status, location_unavailable)
       VALUES ($1, 'posted', $2)
       ON CONFLICT (load_id) DO NOTHING`,
      [loadId, locUnavailable]
    );
    return null;
  }

  if (mode === "posted_gps") {
    await run(
      `INSERT INTO shipments (load_id, status, location_unavailable)
       VALUES ($1, 'posted', true)
       ON CONFLICT (load_id) DO NOTHING`,
      [loadId]
    );
    return null;
  }

  if (mode === "get_or_create") {
    const { rows } = await run(
      `INSERT INTO shipments (load_id, status, location_unavailable)
       VALUES ($1, 'posted', true)
       ON CONFLICT (load_id)
       DO UPDATE SET load_id = EXCLUDED.load_id
       RETURNING id, load_id, status, current_lat, current_lng, location_unavailable, updated_at`,
      [loadId]
    );
    return rows[0] || null;
  }

  if (mode === "booked_upsert") {
    const { rows } = await run(
      `INSERT INTO shipments (load_id, booking_id, status, location_unavailable)
       VALUES ($1, $2, 'booked', true)
       ON CONFLICT (load_id)
       DO UPDATE SET booking_id = EXCLUDED.booking_id, status = 'booked', updated_at = now()
       RETURNING id, load_id, status, booking_id`,
      [loadId, bookingId]
    );
    return rows[0] || null;
  }

  if (mode === "booked_insert") {
    const { rows } = await run(
      `INSERT INTO shipments (load_id, booking_id, status, location_unavailable)
       VALUES ($1, $2, 'booked', true)
       RETURNING id, load_id, status, booking_id`,
      [loadId, bookingId]
    );
    return rows[0] || null;
  }

  throw new Error(`Unknown shipment factory mode: ${mode}`);
}

/**
 * Idempotent booked milestone on shipment_events.
 */
async function ensureShipmentBookedEvent(client, { loadId, shipmentId = null, note = null }) {
  const run = (text, params) => {
    if (client && typeof client.query === "function") return client.query(text, params);
    return query(text, params);
  };

  if (shipmentId) {
    await run(
      `INSERT INTO shipment_events (shipment_id, status, note, location_label)
       SELECT $1, 'booked', $2, 'System'
       WHERE NOT EXISTS (
         SELECT 1 FROM shipment_events e WHERE e.shipment_id = $1 AND e.status = 'booked'
       )`,
      [shipmentId, note]
    );
    return;
  }

  await run(
    `INSERT INTO shipment_events (shipment_id, status, note, location_label)
     SELECT s.id, 'booked', $2, 'System'
     FROM shipments s
     WHERE s.load_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM shipment_events e
         WHERE e.shipment_id = s.id AND e.status = 'booked'
       )`,
    [loadId, note]
  );
}

module.exports = { createShipmentUnified, ensureShipmentBookedEvent };
