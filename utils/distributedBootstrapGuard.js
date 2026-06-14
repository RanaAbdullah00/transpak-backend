/**
 * Phase 7 — startup guard for strict distributed mode (Redis + pub/sub + sequence lock).
 */
const { getRedisClient, getRedisMode } = require("./redisClient");
const { requiresRedis, getDistributedModeSummary } = require("./distributedMode");

const HEALTH_SEQ_KEY = "transpak:health:seq";
const HEALTH_PING_CHANNEL = "transpak:health:ping";

/** @type {{ ok: boolean, redis: boolean, pubsub: boolean, sequenceLock: boolean, reason: string|null, checkedAt: number|null }} */
let lastGuardResult = {
  ok: true,
  redis: false,
  pubsub: false,
  sequenceLock: false,
  reason: null,
  checkedAt: null
};

async function verifyRedisConnectivity() {
  const redis = getRedisClient();
  if (!redis.isEnabled()) {
    return { ok: false, reason: "redis_not_enabled" };
  }
  const start = Date.now();
  try {
    const seq = await redis.incr(HEALTH_SEQ_KEY);
    if (!Number.isFinite(Number(seq)) || Number(seq) < 1) {
      return { ok: false, reason: "incr_failed", latencyMs: Date.now() - start };
    }
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, reason: err?.message || "redis_ping_failed", latencyMs: Date.now() - start };
  }
}

async function verifyPubSub() {
  const redis = getRedisClient();
  if (!redis.isEnabled()) {
    return { ok: false, reason: "redis_not_enabled" };
  }
  return new Promise((resolve) => {
    const sub = redis.duplicate();
    const token = `ping-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sub.unsubscribe?.(HEALTH_PING_CHANNEL);
      } catch {
        /* ignore */
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: "pubsub_timeout" }), 3000);
    sub.on?.("message", (channel, message) => {
      if (channel === HEALTH_PING_CHANNEL && String(message) === token) {
        finish({ ok: true });
      }
    });
    sub.subscribe?.(HEALTH_PING_CHANNEL).then(() => {
      redis.publish(HEALTH_PING_CHANNEL, token).catch(() => finish({ ok: false, reason: "publish_failed" }));
    }).catch(() => finish({ ok: false, reason: "subscribe_failed" }));
  });
}

async function verifySequenceLockHealth() {
  const conn = await verifyRedisConnectivity();
  return { ok: conn.ok, reason: conn.reason || null };
}

async function runDistributedBootstrapGuard({ throwOnFail = true } = {}) {
  const mode = getDistributedModeSummary();
  if (!mode.requiresRedis) {
    lastGuardResult = {
      ok: true,
      redis: getRedisMode() === "redis",
      pubsub: getRedisMode() === "redis",
      sequenceLock: getRedisMode() === "redis",
      reason: null,
      checkedAt: Date.now()
    };
    return lastGuardResult;
  }

  const redisCheck = await verifyRedisConnectivity();
  const pubsubCheck = redisCheck.ok ? await verifyPubSub() : { ok: false, reason: "redis_unavailable" };
  const seqCheck = redisCheck.ok ? await verifySequenceLockHealth() : { ok: false, reason: "redis_unavailable" };

  const ok = redisCheck.ok && pubsubCheck.ok && seqCheck.ok;
  lastGuardResult = {
    ok,
    redis: redisCheck.ok,
    pubsub: pubsubCheck.ok,
    sequenceLock: seqCheck.ok,
    reason: ok
      ? null
      : redisCheck.reason || pubsubCheck.reason || seqCheck.reason || "distributed_guard_failed",
    checkedAt: Date.now()
  };

  if (!ok && throwOnFail) {
    const msg = `[distributed] strict mode failed: ${lastGuardResult.reason}`;
    // eslint-disable-next-line no-console
    console.error(msg);
    throw new Error(msg);
  }
  return lastGuardResult;
}

function getDistributedHealthSnapshot() {
  const mode = getDistributedModeSummary();
  return {
    ...mode,
    ...lastGuardResult,
    mode: getRedisMode()
  };
}

module.exports = {
  runDistributedBootstrapGuard,
  getDistributedHealthSnapshot,
  verifyRedisConnectivity,
  verifyPubSub,
  verifySequenceLockHealth,
  HEALTH_SEQ_KEY,
  HEALTH_PING_CHANNEL
};
