const { query } = require("../db/pool");
const { notificationScopeClause } = require("./notificationScope");
const { resolveNotificationWorkspace } = require("./notificationWorkspace");

function parseSince(raw) {
  if (!raw) return null;
  const d = new Date(String(raw).trim());
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Reconnect recovery — missed notifications + module freshness + admin audit tail.
 */
async function buildEventSync(auth, req) {
  const uid = auth.userId;
  const workspace = resolveNotificationWorkspace(req);
  const scope = notificationScopeClause(auth, workspace, 2);
  const baseParams = [uid, ...scope.params];
  const since = parseSince(req.query?.since);
  const limit = Math.min(100, Math.max(1, parseInt(req.query?.limit, 10) || 50));
  const roles = auth?.roles || [];
  const isAdmin = roles.includes("admin") && workspace === "admin";

  const { rows: countRows } = await query(
    `SELECT COUNT(*)::int AS count
     FROM notifications
     WHERE receiver_id = $1 AND read = false AND ${scope.sql}`,
    baseParams
  );

  const listParams = [...baseParams];
  let sinceClause = "";
  if (since) {
    listParams.push(since);
    sinceClause = ` AND created_at > $${listParams.length}::timestamptz`;
  }
  listParams.push(limit);

  const { rows: notifRows } = await query(
    `SELECT id, event_id AS "eventId", sender_id AS "senderId", receiver_id AS "receiverId",
            role_type AS "roleType", title, message, read, created_at AS "createdAt"
     FROM notifications
     WHERE receiver_id = $1 AND ${scope.sql}${sinceClause}
     ORDER BY created_at ASC
     LIMIT $${listParams.length}`,
    listParams
  );

  const modules = { shipments: null, bids: null, space: null };
  const refreshScopes = new Set();

  if (roles.includes("shipper") || roles.includes("carrier")) {
    const partyFilter =
      roles.includes("shipper") && roles.includes("carrier")
        ? `(l.shipper_id = $1 OR l.assigned_carrier_id = $1)`
        : roles.includes("shipper")
          ? `l.shipper_id = $1`
          : `l.assigned_carrier_id = $1`;

    const [{ rows: shipTs }, { rows: bidTs }, { rows: spaceTs }] = await Promise.all([
      query(
        `SELECT MAX(GREATEST(s.updated_at, l.updated_at)) AS "updatedAt"
         FROM shipments s
         JOIN loads l ON l.id = s.load_id
         WHERE ${partyFilter}`,
        [uid]
      ),
      query(
        `SELECT MAX(GREATEST(b.updated_at, b.created_at)) AS "updatedAt"
         FROM bids b
         WHERE b.carrier_id = $1 OR b.load_id IN (SELECT id FROM loads WHERE shipper_id = $1)`,
        [uid]
      ),
      query(
        `SELECT MAX(GREATEST(r.updated_at, r.created_at)) AS "updatedAt"
         FROM carrier_space_requests r
         LEFT JOIN carrier_space_listings l ON l.id = r.listing_id
         WHERE r.shipper_id = $1 OR l.carrier_id = $1`,
        [uid]
      )
    ]);

    if (shipTs[0]?.updatedAt) {
      modules.shipments = { updatedAt: new Date(shipTs[0].updatedAt).toISOString() };
      if (!since || new Date(shipTs[0].updatedAt) > new Date(since)) refreshScopes.add("shipments");
    }
    if (bidTs[0]?.updatedAt) {
      modules.bids = { updatedAt: new Date(bidTs[0].updatedAt).toISOString() };
      if (!since || new Date(bidTs[0].updatedAt) > new Date(since)) refreshScopes.add("bids");
    }
    if (spaceTs[0]?.updatedAt) {
      modules.space = { updatedAt: new Date(spaceTs[0].updatedAt).toISOString() };
      if (!since || new Date(spaceTs[0].updatedAt) > new Date(since)) refreshScopes.add("space");
    }
  }

  if (notifRows.length) {
    notifRows.forEach((n) => {
      const t = String(n.title || "").toUpperCase();
      if (t.includes("BID")) refreshScopes.add("bids");
      if (
        t.includes("SHIPMENT") ||
        t.includes("DELIVERY") ||
        t.includes("PICKED") ||
        t.includes("TRANSIT") ||
        t.includes("CONTRACT_STARTED") ||
        t.includes("BID_ACCEPTED")
      ) {
        refreshScopes.add("shipments");
      }
      if (t.includes("SPACE") || t.includes("CAPACITY")) refreshScopes.add("space");
      if (t.includes("LOAD")) refreshScopes.add("loads");
    });
  }

  let auditEvents = [];
  if (isAdmin) {
    const auditParams = [];
    let auditSince = "";
    if (since) {
      auditParams.push(since);
      auditSince = ` WHERE created_at > $1::timestamptz`;
    }
    auditParams.push(Math.min(50, limit));
    const { rows } = await query(
      `SELECT a.id, a.action, a.target_entity AS "targetEntity", a.target_id AS "targetId",
              a.metadata, a.created_at AS "createdAt",
              COALESCE(u.full_name, u.email, 'System') AS "actorName"
       FROM audit_events a
       LEFT JOIN users u ON u.id = a.actor_user_id
       ${auditSince}
       ORDER BY a.created_at DESC
       LIMIT $${auditParams.length}`,
      auditParams
    );
    auditEvents = rows;
    if (rows.length) refreshScopes.add("all");
  }

  return {
    serverTime: new Date().toISOString(),
    since: since || null,
    unreadCount: countRows[0]?.count || 0,
    notifications: notifRows.map((r) => ({ ...r, type: r.title || null })),
    modules,
    refreshScopes: [...refreshScopes],
    auditEvents
  };
}

module.exports = { buildEventSync };
