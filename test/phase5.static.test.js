/**
 * Phase 5 — distributed readiness + observability export gates.
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

describe("Phase 5 — observability export layer", () => {
  it("performanceTelemetryExport builds structured JSON snapshots", () => {
    const src = readFe("utils/performanceTelemetryExport.js");
    assert.ok(src.includes("transpak.perf.v1"));
    assert.ok(src.includes("buildPerformanceExportPayload"));
    assert.ok(src.includes("requestIdleCallback"));
    assert.ok(src.includes("initPerformanceTelemetryExport"));
  });

  it("export is wired at bootstrap without render coupling", () => {
    const src = readFe("main.jsx");
    assert.ok(src.includes("initPerformanceTelemetryExport"));
    assert.ok(!src.includes("usePerformanceTelemetry("));
  });

  it("backend client perf ingest is disabled by default", () => {
    const tel = require("../utils/clientPerfTelemetry");
    assert.equal(tel.isIngestEnabled(), false);
    const result = tel.ingestClientPerfSnapshot({ schema: "test" });
    assert.equal(result.accepted, false);
  });

  it("operations routes expose optional client-perf endpoints", () => {
    const src = read("routes/operationsRoutes.js");
    assert.ok(src.includes('"/client-perf"'));
    assert.ok(src.includes("ingestClientPerfSnapshot"));
  });
});

describe("Phase 5 — Redis adapter inactive by default", () => {
  it("createNotificationDedupeAdapter uses InMemory when Redis unavailable", () => {
    const prev = process.env.NOTIFY_DEDUPE_REDIS;
    const prevUrl = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    process.env.NOTIFY_DEDUPE_REDIS = "1";
    const { createNotificationDedupeAdapter, InMemoryAdapter } = require("../utils/notificationDedupeAdapter");
    const { resetRedisClientForTests } = require("../utils/redisClient");
    resetRedisClientForTests();
    const adapter = createNotificationDedupeAdapter();
    assert.ok(adapter instanceof InMemoryAdapter);
    process.env.NOTIFY_DEDUPE_REDIS = prev;
    process.env.REDIS_URL = prevUrl;
    resetRedisClientForTests();
  });

  it("RedisAdapter uses NX semantics via redis client", async () => {
    const prevUrl = process.env.REDIS_URL;
    const prevStrict = process.env.ENABLE_STRICT_DISTRIBUTED;
    delete process.env.REDIS_URL;
    process.env.ENABLE_STRICT_DISTRIBUTED = "false";
    const { RedisAdapter } = require("../utils/notificationDedupeAdapter");
    const { getRedisClient, resetRedisClientForTests } = require("../utils/redisClient");
    resetRedisClientForTests();
    const adapter = new RedisAdapter(getRedisClient());
    assert.equal(await adapter.has("x"), false);
    await adapter.set("x");
    assert.equal(await adapter.has("x"), true);
    resetRedisClientForTests();
    if (prevUrl != null) process.env.REDIS_URL = prevUrl;
    else delete process.env.REDIS_URL;
    if (prevStrict != null) process.env.ENABLE_STRICT_DISTRIBUTED = prevStrict;
    else delete process.env.ENABLE_STRICT_DISTRIBUTED;
    resetRedisClientForTests();
  });
});

describe("Phase 5 — event contract enforced (cross-layer)", () => {
  it("tracking contract + dedupe integrated at socket ingress and hook buffer", () => {
    assert.ok(readFe("utils/trackingEventContract.js").includes("shouldAcceptTrackingEvent"));
    assert.ok(readFe("context/AppContext.jsx").includes("trackingEventDedupeCache.has"));
    assert.ok(readFe("hooks/useShipmentTracking.js").includes("rememberTrackingEvent"));
  });

  it("NotificationDedupeAdapter exposes cleanup()", async () => {
    const { InMemoryAdapter } = require("../utils/notificationDedupeAdapter");
    const a = new InMemoryAdapter(5000);
    await a.set("k");
    assert.equal(typeof a.cleanup, "function");
    assert.equal(await a.has("k"), true);
  });
});

describe("Phase 5 — Phase 3 invariant lock (regression)", () => {
  it("coordinator keeps FLUSH_MAX_MS = 300 and single control plane", () => {
    const src = readFe("hooks/useTrackingCoordinator.js");
    assert.ok(src.includes("const FLUSH_MAX_MS = 300"));
    assert.ok(readFe("hooks/useShipmentTracking.js").includes("useTrackingCoordinator"));
  });

  it("rating batch path unchanged", () => {
    assert.ok(readFe("hooks/useRatingSummaryBatch.js").includes("/reviews/summary"));
    assert.ok(!readFe("components/loadboard/BidList.jsx").includes("useReceivedRatingSummary"));
    assert.ok(readFe("components/reviews/UserRatingBadge.jsx").includes("lookupRatingSummary"));
  });
});
