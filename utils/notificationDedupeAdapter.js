/**
 * Phase 6 — notification dedupe adapter (Redis primary, in-memory fallback).
 */
const { getRedisClient } = require("./redisClient");
const { buildDedupeKey } = require("./realtimeDispatch");

const DEDUPE_WINDOW_MS = Number(process.env.NOTIFY_DEDUPE_MS || 120000);
const REDIS_TTL_SEC = Number(process.env.NOTIFY_DEDUPE_REDIS_TTL_SEC || 180);

/**
 * Event-safe notification identity — never dedupe across event types or entities.
 * @param {string} eventType
 * @param {string} entityId — bidId, shipmentId, spaceId, etc.
 * @param {string} receiverId
 * @param {string} [eventVersion] — status transition, workflow step, or timestamp bucket
 */
function buildEventDedupeKey(eventType, entityId, receiverId, eventVersion) {
  const parts = [
    String(eventType || "").trim(),
    String(entityId || "").trim(),
    String(receiverId || "").trim()
  ];
  const ver = eventVersion != null ? String(eventVersion).trim() : "";
  if (ver) parts.push(ver);
  return buildDedupeKey(parts);
}

/** Legacy content hash — only when no entityId/eventType identity is available. */
function buildLegacyContentDedupeKey(receiverId, title, message) {
  return buildDedupeKey([receiverId, title, String(message).slice(0, 120)]);
}

class InMemoryAdapter {
  constructor(windowMs = DEDUPE_WINDOW_MS) {
    this.windowMs = windowMs;
    /** @type {Map<string, number>} */
    this.map = new Map();
  }

  async has(eventId) {
    const key = String(eventId || "").trim();
    if (!key) return false;
    const ts = this.map.get(key);
    if (ts == null) return false;
    if (Date.now() - ts > this.windowMs) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  async set(eventId, at = Date.now()) {
    const key = String(eventId || "").trim();
    if (!key) return;
    this.map.set(key, at);
    this.cleanup(at);
  }

  cleanup(now = Date.now()) {
    if (this.map.size < 5000) return;
    this.clearExpired(now);
  }

  clearExpired(now = Date.now()) {
    for (const [k, ts] of this.map) {
      if (now - ts > this.windowMs) this.map.delete(k);
    }
  }
}

class RedisAdapter {
  constructor(redis, ttlSec = REDIS_TTL_SEC) {
    this.redis = redis;
    this.ttlSec = ttlSec;
  }

  async has(eventId) {
    const key = String(eventId || "").trim();
    if (!key || !this.redis) return false;
    const val = await this.redis.get(`notify:dedupe:${key}`);
    return val != null;
  }

  async set(eventId) {
    const key = String(eventId || "").trim();
    if (!key || !this.redis) return;
    await this.redis.setnxex(`notify:dedupe:${key}`, "1", this.ttlSec);
  }

  async cleanup() {
    return undefined;
  }

  async clearExpired() {
    return undefined;
  }
}

function createNotificationDedupeAdapter() {
  const { requiresRedis } = require("./distributedMode");
  const redis = getRedisClient();
  if (redis.isEnabled()) {
    return new RedisAdapter(redis, REDIS_TTL_SEC);
  }
  if (requiresRedis()) {
    throw new Error("[notify] Strict distributed mode requires Redis for notification dedupe");
  }
  if (process.env.NOTIFY_DEDUPE_REDIS === "1") {
    // eslint-disable-next-line no-console
    console.warn("[notify] NOTIFY_DEDUPE_REDIS=1 but REDIS unavailable — using InMemoryAdapter");
  }
  return new InMemoryAdapter();
}

module.exports = {
  InMemoryAdapter,
  RedisAdapter,
  createNotificationDedupeAdapter,
  buildEventDedupeKey,
  buildLegacyContentDedupeKey,
  DEDUPE_WINDOW_MS
};
