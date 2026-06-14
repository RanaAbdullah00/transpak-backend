/**
 * Phase 6 — Redis client with graceful in-memory fallback.
 */
let RedisImpl = null;
try {
  RedisImpl = require("ioredis");
} catch {
  RedisImpl = null;
}

const memoryStore = new Map();
let client = null;
let mode = "memory";
let warnedFallback = false;

function warnFallback(reason) {
  if (warnedFallback) return;
  warnedFallback = true;
  // eslint-disable-next-line no-console
  console.warn(`[redis] degraded mode (in-memory fallback): ${reason}`);
}

function createMemoryClient() {
  return {
    isEnabled: () => false,
    mode: () => "memory",
    async get(key) {
      const e = memoryStore.get(key);
      if (!e) return null;
      if (Date.now() > e.exp) {
        memoryStore.delete(key);
        return null;
      }
      return e.val;
    },
    async set(key, val, modeArg, ttlMode, ttlSec) {
      if (modeArg === "EX" || ttlMode === "EX") {
        const sec = Number(ttlSec || modeArg) || 120;
        memoryStore.set(key, { val, exp: Date.now() + sec * 1000 });
        return "OK";
      }
      if (modeArg === "NX") {
        if (memoryStore.has(key)) return null;
      }
      memoryStore.set(key, { val, exp: Date.now() + 120000 });
      return "OK";
    },
    async setnxex(key, val, ttlSec = 120) {
      if (memoryStore.has(key)) {
        const e = memoryStore.get(key);
        if (e && Date.now() <= e.exp) return false;
      }
      memoryStore.set(key, { val, exp: Date.now() + ttlSec * 1000 });
      return true;
    },
    async incr(key) {
      const cur = Number((await this.get(key)) || 0);
      const next = cur + 1;
      await this.set(key, String(next));
      return next;
    },
    async publish() {
      return 0;
    },
    duplicate() {
      return this;
    },
    async subscribe() {
      return undefined;
    },
    on() {
      return undefined;
    }
  };
}

function getRedisClient() {
  if (client) return client;

  const url = String(process.env.REDIS_URL || "").trim();
  if (!url || !RedisImpl) {
    if (!url && process.env.NOTIFY_DEDUPE_REDIS === "1") {
      warnFallback("REDIS_URL not set");
    }
    client = createMemoryClient();
    mode = "memory";
    return client;
  }

  try {
    const redis = new RedisImpl(url, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      lazyConnect: true
    });
    redis.on("error", (err) => {
      warnFallback(err?.message || "connection error");
    });
    client = {
      isEnabled: () => true,
      mode: () => "redis",
      get: (...args) => redis.get(...args),
      set: (...args) => redis.set(...args),
      async setnxex(key, val, ttlSec = 120) {
        const res = await redis.set(key, val, "EX", ttlSec, "NX");
        return res === "OK";
      },
      incr: (key) => redis.incr(key),
      publish: (ch, msg) => redis.publish(ch, msg),
      duplicate: () => redis.duplicate(),
      on: (...args) => redis.on(...args),
      subscribe: (...args) => redis.subscribe(...args)
    };
    mode = "redis";
    redis.connect?.().catch(() => warnFallback("connect failed"));
    return client;
  } catch (err) {
    warnFallback(err?.message || "init failed");
    client = createMemoryClient();
    mode = "memory";
    return client;
  }
}

function getRedisMode() {
  getRedisClient();
  return mode;
}

function resetRedisClientForTests() {
  client = null;
  mode = "memory";
  memoryStore.clear();
  warnedFallback = false;
}

module.exports = {
  getRedisClient,
  getRedisMode,
  resetRedisClientForTests
};
