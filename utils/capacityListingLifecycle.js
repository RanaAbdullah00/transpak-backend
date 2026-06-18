const { query } = require("../db/pool");

const LISTING_STATUSES = new Set([
  "open",
  "requested",
  "accepted",
  "active",
  "delivered",
  "closed",
  "expired"
]);

const LISTING_TRANSITIONS = {
  open: new Set(["requested", "closed", "expired"]),
  requested: new Set(["accepted", "active", "closed", "expired", "open"]),
  accepted: new Set(["active", "closed", "expired"]),
  active: new Set(["delivered", "closed"]),
  delivered: new Set(["closed"]),
  closed: new Set(["open"]),
  expired: new Set(["open"])
};

function assertCapacityListingTransition(from, to) {
  const f = String(from || "").toLowerCase();
  const t = String(to || "").toLowerCase();
  if (!LISTING_STATUSES.has(t)) {
    const err = new Error(`Invalid listing status: ${t}`);
    err.statusCode = 400;
    err.code = "INVALID_LISTING_STATUS";
    throw err;
  }
  const allowed = LISTING_TRANSITIONS[f];
  if (!allowed || !allowed.has(t)) {
    const err = new Error(`Cannot transition listing from ${f} to ${t}`);
    err.statusCode = 409;
    err.code = "INVALID_LISTING_TRANSITION";
    throw err;
  }
}

async function fetchListingForUpdate(client, id) {
  const q = client ? client.query.bind(client) : query;
  const { rows } = await q(`SELECT * FROM carrier_space_listings WHERE id = $1 FOR UPDATE`, [id]);
  return rows[0] || null;
}

async function hasActiveAgreements(client, listingId) {
  const q = client ? client.query.bind(client) : query;
  const { rows } = await q(
    `SELECT 1 FROM carrier_space_requests
     WHERE listing_id = $1 AND status IN ('active', 'in_transit', 'delivered')
     LIMIT 1`,
    [listingId]
  );
  return rows.length > 0;
}

async function closeCapacityListing(id, actor, client = null) {
  const q = client ? client.query.bind(client) : query;
  const row = await fetchListingForUpdate(client, id);
  if (!row) {
    const err = new Error("Listing not found");
    err.statusCode = 404;
    throw err;
  }
  if (String(row.carrier_id) !== String(actor.userId) && !actor.isAdmin) {
    const err = new Error("You do not own this listing");
    err.statusCode = 403;
    err.code = "FORBIDDEN_OWNER";
    throw err;
  }
  if (row.status === "closed") return row;
  assertCapacityListingTransition(row.status, "closed");
  if (await hasActiveAgreements(client, id)) {
    const err = new Error("Listing has an active agreement and cannot be closed");
    err.statusCode = 409;
    err.code = "LISTING_ACTIVE";
    throw err;
  }
  const { rows } = await q(
    `UPDATE carrier_space_listings SET status = 'closed', updated_at = now() WHERE id = $1
     RETURNING id, origin, destination, status, updated_at AS "updatedAt"`,
    [id]
  );
  return rows[0];
}

async function reopenCapacityListing(id, actor, client = null) {
  const q = client ? client.query.bind(client) : query;
  const row = await fetchListingForUpdate(client, id);
  if (!row) {
    const err = new Error("Listing not found");
    err.statusCode = 404;
    throw err;
  }
  if (String(row.carrier_id) !== String(actor.userId) && !actor.isAdmin) {
    const err = new Error("You do not own this listing");
    err.statusCode = 403;
    err.code = "FORBIDDEN_OWNER";
    throw err;
  }
  assertCapacityListingTransition(row.status, "open");
  if (await hasActiveAgreements(client, id)) {
    const err = new Error("Listing has active agreements and cannot be reopened");
    err.statusCode = 409;
    err.code = "LISTING_ACTIVE";
    throw err;
  }
  const { rows } = await q(
    `UPDATE carrier_space_listings SET status = 'open', updated_at = now() WHERE id = $1
     RETURNING id, origin, destination, status, updated_at AS "updatedAt"`,
    [id]
  );
  return rows[0];
}

async function expireCapacityListing(id, actor, client = null) {
  const q = client ? client.query.bind(client) : query;
  const row = await fetchListingForUpdate(client, id);
  if (!row) {
    const err = new Error("Listing not found");
    err.statusCode = 404;
    throw err;
  }
  const isOwner = String(row.carrier_id) === String(actor.userId);
  if (!isOwner && !actor.isAdmin) {
    const err = new Error("Forbidden");
    err.statusCode = 403;
    throw err;
  }
  if (row.status === "expired") return row;
  if (!["open", "requested", "accepted"].includes(row.status)) {
    const err = new Error("Only open or pending listings can be expired");
    err.statusCode = 409;
    err.code = "LISTING_LOCKED";
    throw err;
  }
  assertCapacityListingTransition(row.status, "expired");
  await q(
    `UPDATE carrier_space_requests
     SET status = 'expired', updated_at = now()
     WHERE listing_id = $1 AND status = 'request_sent'`,
    [id]
  );
  const { rows } = await q(
    `UPDATE carrier_space_listings SET status = 'expired', updated_at = now() WHERE id = $1
     RETURNING id, origin, destination, status, updated_at AS "updatedAt"`,
    [id]
  );
  return rows[0];
}

async function closeExpiredCapacityListings(client = null) {
  const q = client ? client.query.bind(client) : query;
  const { rows: expiredIds } = await q(
    `SELECT id FROM carrier_space_listings
     WHERE status IN ('open', 'requested')
       AND (
         (available_from IS NOT NULL AND available_from < CURRENT_DATE)
         OR EXISTS (
           SELECT 1
           FROM jsonb_array_elements(COALESCE(availability_slots, '[]'::jsonb)) elem
           WHERE elem->>'type' = 'visibility'
             AND elem->>'visibleUntil' IS NOT NULL
             AND (elem->>'visibleUntil')::timestamptz < now()
         )
       )`
  );
  for (const { id } of expiredIds) {
    await q(
      `UPDATE carrier_space_requests
       SET status = 'expired', updated_at = now()
       WHERE listing_id = $1 AND status = 'request_sent'`,
      [id]
    );
  }
  const { rowCount } = await q(
    `UPDATE carrier_space_listings
     SET status = 'expired', updated_at = now()
     WHERE status IN ('open', 'requested')
       AND (
         (available_from IS NOT NULL AND available_from < CURRENT_DATE)
         OR EXISTS (
           SELECT 1
           FROM jsonb_array_elements(COALESCE(availability_slots, '[]'::jsonb)) elem
           WHERE elem->>'type' = 'visibility'
             AND elem->>'visibleUntil' IS NOT NULL
             AND (elem->>'visibleUntil')::timestamptz < now()
         )
       )`
  );
  return rowCount || 0;
}

async function markListingRequested(listingId, client = null) {
  const q = client ? client.query.bind(client) : query;
  await q(
    `UPDATE carrier_space_listings
     SET status = CASE WHEN status = 'open' THEN 'requested' ELSE status END,
         updated_at = now()
     WHERE id = $1 AND status IN ('open', 'requested')`,
    [listingId]
  );
}

async function syncListingStatusFromShipment(loadId, shipmentStatus, client = null) {
  const q = client ? client.query.bind(client) : query;
  const canonical = String(shipmentStatus || "").toLowerCase();
  const listingMap = {
    booked: "accepted",
    pickedup: "active",
    intransit: "active",
    delivered: "delivered",
    closed: "closed"
  };
  const nextListing = listingMap[canonical];
  if (!nextListing) return;
  await q(
    `UPDATE carrier_space_listings l
     SET status = $2, updated_at = now()
     FROM carrier_space_requests r
     WHERE r.listing_id = l.id AND r.load_id = $1
       AND r.status NOT IN ('rejected', 'expired', 'completed')
       AND l.status NOT IN ('closed', 'expired')`,
    [loadId, nextListing]
  );
}

module.exports = {
  LISTING_STATUSES,
  assertCapacityListingTransition,
  closeCapacityListing,
  reopenCapacityListing,
  expireCapacityListing,
  closeExpiredCapacityListings,
  markListingRequested,
  syncListingStatusFromShipment
};
