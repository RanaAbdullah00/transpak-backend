const { query, getPool } = require("../db/pool");

async function safeCount(sql, params = []) {
  try {
    const { rows } = await query(sql, params);
    const n = rows[0]?.c;
    return Number.isFinite(Number(n)) ? Number(n) : 0;
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn("[admin/stats] count failed:", err?.message || err, sql.slice(0, 80));
    }
    return null;
  }
}

async function pingDatabase() {
  try {
    const pool = getPool();
    if (!pool) return false;
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/**
 * Aggregated admin dashboard metrics — never throws; null counts mean query failed.
 */
async function fetchAdminLiveStats() {
  const dbReachable = await pingDatabase();

  const [
    totalUsers,
    activeUsers,
    totalLoads,
    openLoads,
    completedShipments,
    totalBids,
    activeShipments,
    openDisputes,
    pendingVerification,
    shipperAccounts,
    carrierAccounts,
    incompleteProfiles,
    registeredTrucks,
    notificationsToday
  ] = await Promise.all([
    safeCount(`SELECT COUNT(*)::int AS c FROM users`),
    safeCount(
      `SELECT COUNT(*)::int AS c FROM users
       WHERE blocked = false AND verified = true
         AND updated_at >= now() - interval '30 days'`
    ),
    safeCount(`SELECT COUNT(*)::int AS c FROM loads`),
    safeCount(`SELECT COUNT(*)::int AS c FROM loads WHERE status = 'open'`),
    safeCount(`SELECT COUNT(*)::int AS c FROM shipments WHERE status IN ('delivered','closed')`),
    safeCount(`SELECT COUNT(*)::int AS c FROM bids`),
    safeCount(
      `SELECT COUNT(*)::int AS c FROM shipments WHERE status IN ('booked','pickedup','intransit','delivered')`
    ),
    safeCount(`SELECT COUNT(*)::int AS c FROM disputes WHERE status = 'open'`),
    safeCount(`SELECT COUNT(*)::int AS c FROM users WHERE verified = false AND blocked = false`),
    safeCount(`SELECT COUNT(*)::int AS c FROM users WHERE 'shipper' = ANY(roles)`),
    safeCount(`SELECT COUNT(*)::int AS c FROM users WHERE 'carrier' = ANY(roles)`),
    safeCount(`SELECT COUNT(*)::int AS c FROM users WHERE is_profile_complete = false`),
    safeCount(`SELECT COUNT(*)::int AS c FROM trucks`),
    safeCount(
      `SELECT COUNT(*)::int AS c FROM notifications WHERE created_at >= date_trunc('day', now())`
    )
  ]);

  const normalize = (v) => (v === null ? 0 : v);

  return {
    dbReachable,
    stats: {
      totalUsers: normalize(totalUsers),
      activeUsers: normalize(activeUsers),
      totalLoads: normalize(totalLoads),
      openLoads: normalize(openLoads),
      completedShipments: normalize(completedShipments),
      totalBids: normalize(totalBids),
      activeShipments: normalize(activeShipments),
      openDisputes: normalize(openDisputes),
      pendingVerification: normalize(pendingVerification),
      shipperAccounts: normalize(shipperAccounts),
      carrierAccounts: normalize(carrierAccounts),
      incompleteProfiles: normalize(incompleteProfiles),
      registeredTrucks: normalize(registeredTrucks),
      notificationsToday: normalize(notificationsToday),
      generatedAt: new Date().toISOString()
    },
    partialFailure: [totalUsers, totalLoads, totalBids].some((v) => v === null)
  };
}

module.exports = { fetchAdminLiveStats, pingDatabase, safeCount };
