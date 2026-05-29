const { query } = require("../db/pool");
const { sendSuccess } = require("./apiResponse");
const { asyncHandler } = require("./asyncHandler");
const realtimeHub = require("../services/realtimeHub");

const getAdminDashboardLive = asyncHandler(async (req, res) => {
  const { runMarketplaceExpiryProcessor } = require("./loadExpiry");
  await runMarketplaceExpiryProcessor().catch(() => ({ loadsExpired: 0, bidsExpired: 0 }));

  const { fetchAdminLiveStats } = require("./adminStats");
  const liveStats = await fetchAdminLiveStats();

  const serverStartedAt = global.__TRANSPAK_SERVER_STARTED_AT || new Date().toISOString();
  const uptimeSeconds = Math.floor(process.uptime());

  const [
    recentLoads,
    recentBids,
    recentShipments,
    recentUsers,
    recentDisputes,
    recentNotifications,
    auditEvents
  ] = await Promise.all([
    query(
      `SELECT l.id, l.code, l.origin, l.destination, l.status, l.created_at AS "createdAt",
              COALESCE(u.full_name, u.email) AS "shipperName"
       FROM loads l
       JOIN users u ON u.id = l.shipper_id
       ORDER BY l.created_at DESC LIMIT 12`
    ).then((r) => r.rows),
    query(
      `SELECT b.id, b.amount, b.status, b.created_at AS "createdAt",
              l.code AS "loadCode",
              COALESCE(uc.full_name, uc.email) AS "carrierName"
       FROM bids b
       JOIN loads l ON l.id = b.load_id
       JOIN users uc ON uc.id = b.carrier_id
       ORDER BY b.created_at DESC LIMIT 12`
    ).then((r) => r.rows),
    query(
      `SELECT s.id, s.status, s.updated_at AS "updatedAt", l.code AS "loadCode"
       FROM shipments s
       JOIN loads l ON l.id = s.load_id
       ORDER BY s.updated_at DESC LIMIT 12`
    ).then((r) => r.rows),
    query(
      `SELECT id, COALESCE(full_name, email) AS name, email, roles,
              is_profile_complete AS "profileComplete", created_at AS "createdAt"
       FROM users ORDER BY created_at DESC LIMIT 10`
    ).then((r) => r.rows),
    query(
      `SELECT id, load_code AS "loadCode", reason, status, created_at AS "createdAt"
       FROM disputes ORDER BY created_at DESC LIMIT 8`
    ).then((r) => r.rows),
    query(
      `SELECT id, title, message, role_type AS "roleType", read, created_at AS "createdAt"
       FROM notifications ORDER BY created_at DESC LIMIT 10`
    ).then((r) => r.rows),
    query(
      `SELECT a.id, a.action, a.target_entity AS "targetEntity", a.target_id AS "targetId",
              a.metadata, a.created_at AS "createdAt",
              COALESCE(u.full_name, u.email, 'System') AS "actorName"
       FROM audit_events a
       LEFT JOIN users u ON u.id = a.actor_user_id
       ORDER BY a.created_at DESC
       LIMIT 25`
    )
      .then((r) => r.rows)
      .catch(() => [])
  ]);

  return sendSuccess(res, 200, {
    meta: {
      dbReachable: liveStats.dbReachable,
      partialFailure: liveStats.partialFailure
    },
    stats: liveStats.stats,
    observability: {
      uptimeSeconds,
      serverStartedAt,
      websocketConnections: realtimeHub.getConnectedSocketCount()
    },
    recentLoads,
    recentBids,
    recentShipments,
    recentUsers,
    recentDisputes,
    recentNotifications,
    auditEvents
  });
});

module.exports = { getAdminDashboardLive };
