/**
 * Phase 6 — distributed production hardening gates.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const frontendSrc = path.join(__dirname, "..", "..", "transpak-frontend", "src");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function readFe(rel) {
  return fs.readFileSync(path.join(frontendSrc, rel), "utf8");
}

describe("Phase 6 — idempotency + ordering", () => {
  it("withIdempotencyKey middleware exists", () => {
    const src = read("middleware/withIdempotencyKey.js");
    assert.ok(src.includes("withIdempotencyKey"));
    assert.ok(src.includes("idempotency-key"));
  });

  it("sequenceGenerator and tracking publisher enforce sequenceId", () => {
    assert.ok(read("utils/sequenceGenerator.js").includes("nextSequenceId"));
    const pub = read("utils/trackingEventPublisher.js");
    assert.ok(pub.includes("sequenceId"));
    assert.ok(pub.includes("claimDistributedEvent"));
  });

  it("migration 027 creates idempotency + replay log tables", () => {
    const sql = read("db/migrations/027_phase6_distributed.sql");
    assert.ok(sql.includes("idempotency_keys"));
    assert.ok(sql.includes("shipment_event_log"));
    assert.ok(sql.includes("global_sequences"));
  });

  it("write routes use idempotency middleware", () => {
    assert.ok(read("routes/shipmentRoutes.js").includes('withIdempotencyKey("shipment_status")'));
    assert.ok(read("routes/reviewRoutes.js").includes('withIdempotencyKey("reviews")'));
  });
});

describe("Phase 6 — Redis distributed core", () => {
  it("redis client falls back to memory without REDIS_URL", () => {
    const { getRedisClient, getRedisMode, resetRedisClientForTests } = require("../utils/redisClient");
    resetRedisClientForTests();
    const prev = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    const client = getRedisClient();
    assert.equal(client.isEnabled(), false);
    assert.equal(getRedisMode(), "memory");
    process.env.REDIS_URL = prev;
    resetRedisClientForTests();
  });

  it("NotificationDedupeAdapter uses RedisAdapter when redis enabled", async () => {
    const { RedisAdapter } = require("../utils/notificationDedupeAdapter");
    const { getRedisClient, resetRedisClientForTests } = require("../utils/redisClient");
    resetRedisClientForTests();
    const adapter = new RedisAdapter(getRedisClient());
    assert.equal(await adapter.has("phase6-key"), false);
    await adapter.set("phase6-key");
    assert.equal(await adapter.has("phase6-key"), true);
    resetRedisClientForTests();
  });

  it("socketEventDedupe blocks duplicate eventId claims", async () => {
    const { claimDistributedEvent } = require("../utils/socketEventDedupe");
    const { resetRedisClientForTests } = require("../utils/redisClient");
    resetRedisClientForTests();
    assert.equal(await claimDistributedEvent("evt-phase6-a"), true);
    assert.equal(await claimDistributedEvent("evt-phase6-a"), false);
    resetRedisClientForTests();
  });
});

describe("Phase 6 — distributed socket + observability", () => {
  it("distributed socket bus initializes with reorder buffer", () => {
    const src = read("services/distributedSocketBus.js");
    assert.ok(src.includes("initDistributedSocketBus"));
    assert.ok(src.includes("REORDER_MS"));
    assert.ok(src.includes("tracking:update"));
  });

  it("metrics routes expose admin snapshot + client ingest", () => {
    const src = read("routes/metricsRoutes.js");
    assert.ok(src.includes('"/ingest"'));
    assert.ok(src.includes("getMetricsSnapshot"));
    assert.ok(src.includes("prometheus"));
  });

  it("replay route returns ordered shipment events", () => {
    const src = read("routes/replayRoutes.js");
    assert.ok(src.includes('"/shipment/:id"'));
    assert.ok(src.includes("buildCausalTree"));
  });

  it("frontend posts telemetry to /metrics/ingest", () => {
    const src = readFe("utils/performanceTelemetryExport.js");
    assert.ok(src.includes("/metrics/ingest"));
  });

  it("frontend sequence authority gate exists", () => {
    const src = readFe("utils/trackingSequenceAuthority.js");
    assert.ok(src.includes("createSequenceAuthorityGate"));
    assert.ok(readFe("hooks/useShipmentTracking.js").includes("sequenceGateRef"));
  });
});

describe("Phase 6 — Phase 3 invariant preservation", () => {
  it("rating batch + coordinator architecture unchanged", () => {
    assert.ok(readFe("hooks/useRatingSummaryBatch.js").includes("/reviews/summary"));
    assert.ok(readFe("hooks/useTrackingCoordinator.js").includes("const FLUSH_MAX_MS = 300"));
    assert.ok(!readFe("components/reviews/UserRatingBadge.jsx").includes("useApi"));
  });
});
