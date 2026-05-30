const { query } = require("../db/pool");
const { safeCount, pingDatabase } = require("./adminStats");
const { recordAdminTelemetry, getAdminTelemetrySnapshot } = require("./adminTelemetry");
const realtimeHub = require("../services/realtimeHub");

async function runWidget(widget, fn) {
  const start = Date.now();
  try {
    const data = await fn();
    const durationMs = Date.now() - start;
    recordAdminTelemetry({ widget, event: "fetch_ok", durationMs, ok: true });
    return { ok: true, widget, data, durationMs, error: null };
  } catch (err) {
    const durationMs = Date.now() - start;
    const code = err?.code != null ? String(err.code) : "WIDGET_ERROR";
    recordAdminTelemetry({
      widget,
      event: "fetch_fail",
      durationMs,
      ok: false,
      code,
      meta: { message: String(err?.message || err).slice(0, 80) }
    });
    return {
      ok: false,
      widget,
      data: null,
      durationMs,
      error: {
        code,
        message:
          code === '42P01' || code === '42703'
            ? 'Database schema mismatch'
            : code === 'ECONNREFUSED' || code === 'ENOTFOUND'
              ? 'Database unreachable'
              : 'Query failed'
      }
    };
  }
}

async function fetchUsersWidget() {
  return runWidget("users", async () => {
    const [
      totalUsers,
      activeUsers,
      shipperAccounts,
      carrierAccounts,
      incompleteProfiles,
      pendingVerification,
      openDisputes,
      registeredTrucks,
      notificationsToday,
      recentUsers
    ] = await Promise.all([
      safeCount(`SELECT COUNT(*)::int AS c FROM users`),
      safeCount(
        `SELECT COUNT(*)::int AS c FROM users
         WHERE blocked = false AND verified = true
           AND updated_at >= now() - interval '30 days'`
      ),
      safeCount(`SELECT COUNT(*)::int AS c FROM users WHERE 'shipper' = ANY(roles)`),
      safeCount(`SELECT COUNT(*)::int AS c FROM users WHERE 'carrier' = ANY(roles)`),
      safeCount(`SELECT COUNT(*)::int AS c FROM users WHERE is_profile_complete = false`),
      safeCount(`SELECT COUNT(*)::int AS c FROM users WHERE verified = false AND blocked = false`),
      safeCount(`SELECT COUNT(*)::int AS c FROM disputes WHERE status = 'open'`),
      safeCount(`SELECT COUNT(*)::int AS c FROM trucks`),
      safeCount(
        `SELECT COUNT(*)::int AS c FROM notifications WHERE created_at >= date_trunc('day', now())`
      ),
      query(
        `SELECT id, COALESCE(full_name, email) AS name, email, roles,
                is_profile_complete AS "profileComplete", created_at AS "createdAt"
         FROM users ORDER BY created_at DESC LIMIT 10`
      ).then((r) => r.rows)
    ]);

    const n = (v) => (v === null ? null : v);
    const normalizeUserRoles = (rows) =>
      (Array.isArray(rows) ? rows : []).map((u) => ({
        ...u,
        roles: Array.isArray(u.roles) ? u.roles : u.roles ? [String(u.roles)] : []
      }));
    return {
      stats: {
        totalUsers: n(totalUsers),
        activeUsers: n(activeUsers),
        shipperAccounts: n(shipperAccounts),
        carrierAccounts: n(carrierAccounts),
        incompleteProfiles: n(incompleteProfiles),
        pendingVerification: n(pendingVerification),
        openDisputes: n(openDisputes),
        registeredTrucks: n(registeredTrucks),
        notificationsToday: n(notificationsToday)
      },
      recentUsers: normalizeUserRoles(recentUsers),
      partialFailure: [totalUsers, shipperAccounts].some((v) => v === null)
    };
  });
}

async function fetchLoadsWidget() {
  return runWidget("loads", async () => {
    const [totalLoads, openLoads, recentLoads] = await Promise.all([
      safeCount(`SELECT COUNT(*)::int AS c FROM loads`),
      safeCount(`SELECT COUNT(*)::int AS c FROM loads WHERE status = 'open'`),
      query(
        `SELECT l.id, l.code, l.origin, l.destination, l.status, l.created_at AS "createdAt",
                COALESCE(u.full_name, u.email) AS "shipperName"
         FROM loads l
         JOIN users u ON u.id = l.shipper_id
         ORDER BY l.created_at DESC LIMIT 12`
      ).then((r) => r.rows)
    ]);
    const n = (v) => (v === null ? null : v);
    return {
      stats: { totalLoads: n(totalLoads), openLoads: n(openLoads) },
      recentLoads,
      partialFailure: totalLoads === null
    };
  });
}

async function fetchBidsWidget() {
  return runWidget("bids", async () => {
    const [totalBids, recentBids] = await Promise.all([
      safeCount(`SELECT COUNT(*)::int AS c FROM bids`),
      query(
        `SELECT b.id, b.amount, b.status, b.created_at AS "createdAt",
                l.code AS "loadCode",
                COALESCE(uc.full_name, uc.email) AS "carrierName"
         FROM bids b
         JOIN loads l ON l.id = b.load_id
         JOIN users uc ON uc.id = b.carrier_id
         ORDER BY b.created_at DESC LIMIT 12`
      ).then((r) => r.rows)
    ]);
    const n = (v) => (v === null ? null : v);
    return {
      stats: { totalBids: n(totalBids) },
      recentBids,
      partialFailure: totalBids === null
    };
  });
}

async function fetchShipmentsWidget() {
  return runWidget("shipments", async () => {
    const [activeShipments, completedShipments, recentShipments] = await Promise.all([
      safeCount(
        `SELECT COUNT(*)::int AS c FROM shipments WHERE status IN ('booked','pickedup','intransit','delivered')`
      ),
      safeCount(`SELECT COUNT(*)::int AS c FROM shipments WHERE status IN ('delivered','closed')`),
      query(
        `SELECT s.id, s.status, s.updated_at AS "updatedAt", l.code AS "loadCode"
         FROM shipments s
         JOIN loads l ON l.id = s.load_id
         ORDER BY s.updated_at DESC LIMIT 12`
      ).then((r) => r.rows)
    ]);
    const n = (v) => (v === null ? null : v);
    return {
      stats: {
        activeShipments: n(activeShipments),
        completedShipments: n(completedShipments)
      },
      recentShipments,
      partialFailure: activeShipments === null
    };
  });
}

async function fetchAuditWidget() {
  return runWidget("audit", async () => {
    const [auditEvents, recentDisputes] = await Promise.all([
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
        .catch(() => []),
      query(
        `SELECT id, load_code AS "loadCode", reason, status, created_at AS "createdAt"
         FROM disputes ORDER BY created_at DESC LIMIT 8`
      ).then((r) => r.rows)
    ]);
    return { auditEvents, recentDisputes };
  });
}

async function fetchObservabilityWidget() {
  return runWidget("observability", async () => {
    const dbReachable = await pingDatabase();
    return {
      meta: { dbReachable },
      observability: {
        uptimeSeconds: Math.floor(process.uptime()),
        serverStartedAt: global.__TRANSPAK_SERVER_STARTED_AT || new Date().toISOString(),
        websocketConnections: realtimeHub.getConnectedSocketCount(),
        telemetryRecent: getAdminTelemetrySnapshot(30),
        ops: require("./opsTelemetry").getOpsSnapshot({ includeRecent: true })
      }
    };
  });
}

const WIDGET_FETCHERS = {
  users: fetchUsersWidget,
  loads: fetchLoadsWidget,
  bids: fetchBidsWidget,
  shipments: fetchShipmentsWidget,
  audit: fetchAuditWidget,
  observability: fetchObservabilityWidget
};

async function fetchWidgetByName(name) {
  const fn = WIDGET_FETCHERS[name];
  if (!fn) return { ok: false, widget: name, error: { code: "UNKNOWN_WIDGET" }, data: null };
  return fn();
}

module.exports = {
  WIDGET_FETCHERS,
  fetchWidgetByName,
  fetchUsersWidget,
  fetchLoadsWidget,
  fetchBidsWidget,
  fetchShipmentsWidget,
  fetchAuditWidget,
  fetchObservabilityWidget
};
