/**
 * Phase 7 Enterprise — strict Redis mode gates.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

describe("Phase 7 Enterprise — strict mode fail-fast", () => {
  const saved = {};

  beforeEach(() => {
    saved.ENABLE_STRICT_DISTRIBUTED = process.env.ENABLE_STRICT_DISTRIBUTED;
    saved.DISTRIBUTED_MODE = process.env.DISTRIBUTED_MODE;
    saved.REDIS_URL = process.env.REDIS_URL;
    process.env.ENABLE_STRICT_DISTRIBUTED = "true";
    process.env.DISTRIBUTED_MODE = "multi";
    delete process.env.REDIS_URL;
    delete require.cache[require.resolve("../utils/distributedMode")];
    delete require.cache[require.resolve("../utils/healthStatus")];
    delete require.cache[require.resolve("../utils/distributedBootstrapGuard")];
  });

  afterEach(() => {
    process.env.ENABLE_STRICT_DISTRIBUTED = saved.ENABLE_STRICT_DISTRIBUTED;
    process.env.DISTRIBUTED_MODE = saved.DISTRIBUTED_MODE;
    process.env.REDIS_URL = saved.REDIS_URL;
    const { resetRedisClientForTests } = require("../utils/redisClient");
    resetRedisClientForTests();
    delete require.cache[require.resolve("../utils/distributedMode")];
    delete require.cache[require.resolve("../utils/redisClient")];
  });

  it("requiresRedis when strict + multi", () => {
    const { requiresRedis } = require("../utils/distributedMode");
    assert.equal(requiresRedis(), true);
  });

  it("getRedisClient throws in strict mode without REDIS_URL", () => {
    assert.throws(() => {
      const { getRedisClient, resetRedisClientForTests } = require("../utils/redisClient");
      resetRedisClientForTests();
      getRedisClient();
    }, /strict distributed mode requires Redis/i);
  });

  it("health snapshot marks distributed not ok without redis", () => {
    const { resolveDistributedHealthForApi } = require("../utils/healthStatus");
    const h = resolveDistributedHealthForApi();
    assert.equal(h.requiresRedis, true, JSON.stringify(h));
    assert.equal(h.ok, false);
  });

  it("notification adapter refuses in-memory in strict mode", () => {
    assert.throws(() => {
      const { createNotificationDedupeAdapter } = require("../utils/notificationDedupeAdapter");
      createNotificationDedupeAdapter();
    }, /Strict distributed mode requires Redis/i);
  });
});

describe("Phase 7 Enterprise — non-strict fallback preserved", () => {
  afterEach(() => {
    delete process.env.ENABLE_STRICT_DISTRIBUTED;
    delete process.env.DISTRIBUTED_MODE;
    const { resetRedisClientForTests } = require("../utils/redisClient");
    resetRedisClientForTests();
  });

  it("memory fallback still works when strict off", () => {
    delete process.env.ENABLE_STRICT_DISTRIBUTED;
    delete process.env.REDIS_URL;
    const { getRedisClient, getRedisMode, resetRedisClientForTests } = require("../utils/redisClient");
    resetRedisClientForTests();
    const client = getRedisClient();
    assert.equal(client.isEnabled(), false);
    assert.equal(getRedisMode(), "memory");
  });
});
