/**
 * Phase 6 — cross-instance socket event dedupe (Redis SET NX + TTL).
 */
const { getRedisClient } = require("./redisClient");
const { recordDuplicateBlocked } = require("./metricsCollector");

const DEFAULT_TTL_SEC = Number(process.env.SOCKET_EVENT_DEDUPE_TTL_SEC || 120);

async function claimDistributedEvent(eventId, ttlSec = DEFAULT_TTL_SEC) {
  const key = String(eventId || "").trim();
  if (!key) return true;
  const redis = getRedisClient();
  const redisKey = `event:${key}`;
  try {
    const claimed = await redis.setnxex(redisKey, "1", ttlSec);
    if (!claimed) {
      recordDuplicateBlocked();
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

async function hasDistributedEvent(eventId) {
  const key = String(eventId || "").trim();
  if (!key) return false;
  const redis = getRedisClient();
  try {
    const val = await redis.get(`event:${key}`);
    return val != null;
  } catch {
    return false;
  }
}

module.exports = {
  claimDistributedEvent,
  hasDistributedEvent,
  DEFAULT_TTL_SEC
};
