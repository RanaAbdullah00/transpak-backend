/**
 * Phase 7 Enterprise — static gates (distributed control system).
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

describe("Phase 7 Enterprise — strict distributed mode", () => {
  it("distributedMode and bootstrap guard modules exist", () => {
    assert.ok(read("utils/distributedMode.js").includes("ENABLE_STRICT_DISTRIBUTED"));
    assert.ok(read("utils/distributedBootstrapGuard.js").includes("runDistributedBootstrapGuard"));
    assert.ok(read("utils/redisClient.js").includes("requiresRedis"));
  });

  it("health exposes distributed block", () => {
    assert.ok(read("utils/healthStatus.js").includes("resolveDistributedHealthForApi"));
    assert.ok(read("src/app.js").includes("distributed"));
  });

  it("migration 028 adds causal + tracing + alerts", () => {
    const sql = read("db/migrations/028_phase7_causal_tracing_alerts.sql");
    assert.ok(sql.includes("parent_event_id"));
    assert.ok(sql.includes("trace_spans"));
    assert.ok(sql.includes("system_alerts"));
    assert.equal(read("db/schemaGuard.js").includes('SCHEMA_VERSION = "029"'), true);
  });
});

describe("Phase 7 Enterprise — causal graph + consistency", () => {
  it("causal modules wired into publisher", () => {
    assert.ok(read("utils/causalEventGraph.js").includes("CAUSALITY_TYPES"));
    assert.ok(read("utils/consistencyEngine.js").includes("prepareTrackingEvent"));
    const pub = read("utils/trackingEventPublisher.js");
    assert.ok(pub.includes("parentEventId"));
    assert.ok(pub.includes("causalityType"));
  });

  it("replay returns causal tree", () => {
    assert.ok(read("services/causalReplayEngine.js").includes("buildCausalTree"));
    assert.ok(read("routes/replayRoutes.js").includes("causal"));
  });
});

describe("Phase 7 Enterprise — observability", () => {
  it("trace + alert routes registered", () => {
    assert.ok(read("routes/traceRoutes.js").includes("/shipment/:id"));
    assert.ok(read("routes/alertRoutes.js").includes("/stream"));
    assert.ok(read("src/app.js").includes("/api/traces"));
    assert.ok(read("src/app.js").includes("/api/alerts"));
  });

  it("trace middleware propagates X-Trace-Id", () => {
    assert.ok(read("middleware/traceMiddleware.js").includes("X-Trace-Id"));
  });
});

describe("Phase 7 Enterprise — Phase 3 invariant preservation", () => {
  it("rating batch + coordinator architecture unchanged", () => {
    assert.ok(readFe("hooks/useRatingSummaryBatch.js").includes("/reviews/summary"));
    assert.ok(readFe("hooks/useTrackingCoordinator.js").includes("const FLUSH_MAX_MS = 300"));
    assert.ok(!readFe("components/reviews/UserRatingBadge.jsx").includes("useApi"));
  });
});
