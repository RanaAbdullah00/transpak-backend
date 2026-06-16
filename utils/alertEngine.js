/**
 * Phase 7 — real-time health alerting from metrics + distributed guard.
 */
const { query } = require("../db/pool");
const { getMetricsSnapshot } = require("./metricsCollector");
const { getDistributedHealthSnapshot, verifyRedisConnectivity } = require("./distributedBootstrapGuard");
const { requiresRedis } = require("./distributedMode");
const realtimeHub = require("../services/realtimeHub");
const { notifyAdmins } = require("./notifyEvent");
const { buildDedupeKey } = require("./realtimeDispatch");

const SEVERITY = Object.freeze({
  INFO: "INFO",
  WARNING: "WARNING",
  CRITICAL: "CRITICAL"
});

const THRESHOLDS = {
  duplicateRate: Number(process.env.ALERT_DUPLICATE_RATE || 0.05),
  redisLatencyMs: Number(process.env.ALERT_REDIS_LATENCY_MS || 200),
  reorderPerMin: Number(process.env.ALERT_REORDER_PER_MIN || 10)
};

/** @type {object[]} */
const recentAlerts = [];
let reorderWindow = [];
let started = false;
let lastRedisLatency = 0;

async function persistAlert({ severity, code, message, metadata = {} }) {
  const alert = {
    severity,
    code,
    message,
    metadata,
    createdAt: new Date().toISOString()
  };
  recentAlerts.unshift(alert);
  if (recentAlerts.length > 500) recentAlerts.pop();

  try {
    await query(
      `INSERT INTO system_alerts (severity, code, message, metadata)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [severity, code, message, JSON.stringify(metadata || {})]
    );
  } catch (err) {
    if (process.env.NODE_ENV !== "test") {
      // eslint-disable-next-line no-console
      console.warn("[alertEngine] system_alerts insert failed:", err?.message || err);
    }
  }

  try {
    const io = realtimeHub.getIO();
    io?.to?.("admin")?.emit?.("system:alert", alert);
  } catch {
    /* ignore */
  }

  void notifyAdmins({
    senderId: null,
    title: code || "SYSTEM_ALERT",
    type: "SYSTEM_ALERT",
    message: message || code,
    idempotencyKey: buildDedupeKey(["ADMIN", "SYSTEM_ALERT", code, alert.createdAt]),
    metadata: { severity, ...metadata }
  });

  return alert;
}

function emitAlert(severity, code, message, metadata) {
  return persistAlert({ severity, code, message, metadata });
}

async function evaluateMetricsAlerts() {
  const snap = getMetricsSnapshot();
  const t = snap.tracking || {};
  const throughput = Number(t.eventThroughput) || 0;
  const dup = Number(t.duplicateBlockedCount) || 0;
  const reorder = Number(t.reorderCorrections) || 0;

  if (throughput > 0 && dup / throughput > THRESHOLDS.duplicateRate) {
    await emitAlert(
      SEVERITY.WARNING,
      "duplicate_event_rate",
      `Duplicate event rate ${((dup / throughput) * 100).toFixed(1)}% exceeds threshold`,
      { throughput, dup, threshold: THRESHOLDS.duplicateRate }
    );
  }

  reorderWindow.push({ at: Date.now(), count: reorder });
  reorderWindow = reorderWindow.filter((e) => Date.now() - e.at < 60000);
  const reorderDelta =
    reorderWindow.length > 1
      ? reorderWindow[reorderWindow.length - 1].count - reorderWindow[0].count
      : 0;
  if (reorderDelta > THRESHOLDS.reorderPerMin) {
    await emitAlert(
      SEVERITY.WARNING,
      "reorder_correction_spike",
      `Reorder corrections spiked (${reorderDelta}/min)`,
      { reorderDelta, threshold: THRESHOLDS.reorderPerMin }
    );
  }

  if (requiresRedis()) {
    const ping = await verifyRedisConnectivity();
    lastRedisLatency = ping.latencyMs || 0;
    if (ping.ok && lastRedisLatency > THRESHOLDS.redisLatencyMs) {
      await emitAlert(
        SEVERITY.WARNING,
        "redis_latency",
        `Redis latency ${lastRedisLatency}ms exceeds threshold`,
        { latencyMs: lastRedisLatency, threshold: THRESHOLDS.redisLatencyMs }
      );
    }
    if (!ping.ok) {
      await emitAlert(
        SEVERITY.CRITICAL,
        "redis_unavailable",
        "Redis unavailable in strict distributed mode",
        { reason: ping.reason }
      );
    }
  }

  const dist = getDistributedHealthSnapshot();
  if (dist.requiresRedis && !dist.ok) {
    await emitAlert(
      SEVERITY.CRITICAL,
      "distributed_desync",
      "Distributed control plane unhealthy",
      dist
    );
  }
}

function recordOrphanDetected(shipmentId, eventId) {
  const severity = requiresRedis() ? SEVERITY.CRITICAL : SEVERITY.WARNING;
  return emitAlert(
    severity,
    "causal_orphan",
    "Orphan tracking event detected",
    { shipmentId, eventId }
  );
}

function recordTrackingDesync(meta = {}) {
  return emitAlert(SEVERITY.CRITICAL, "tracking_desync", "Tracking desync detected", meta);
}

function startAlertEngine() {
  if (started) return;
  started = true;
  const intervalMs = Number(process.env.ALERT_POLL_MS || 5000);
  setInterval(() => {
    evaluateMetricsAlerts().catch(() => {});
  }, intervalMs).unref?.();
}

async function listAlerts({ limit = 50, severity = null } = {}) {
  const cap = Math.min(200, Math.max(1, Number(limit) || 50));
  try {
    let sql = `SELECT id, severity, code, message, metadata, created_at AS "createdAt"
               FROM system_alerts`;
    const params = [];
    if (severity) {
      params.push(String(severity).toUpperCase());
      sql += ` WHERE severity = $1`;
    }
    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(cap);
    const { rows } = await query(sql, params);
    return rows;
  } catch {
    return recentAlerts.slice(0, cap);
  }
}

module.exports = {
  SEVERITY,
  startAlertEngine,
  emitAlert,
  evaluateMetricsAlerts,
  recordOrphanDetected,
  recordTrackingDesync,
  listAlerts,
  getRecentAlerts: () => recentAlerts.slice()
};
