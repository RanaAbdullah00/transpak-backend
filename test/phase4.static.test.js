/**
 * Phase 4 — scaling, observability, and multi-instance readiness checks.
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

describe("Phase 4 — observability layer", () => {
  it("usePerformanceTelemetry exports non-blocking metric recorders", () => {
    const src = readFe("hooks/usePerformanceTelemetry.js");
    assert.ok(src.includes("batchRequestCount"));
    assert.ok(src.includes("rAFFlushCount"));
    assert.ok(src.includes("debounceFlushCount"));
    assert.ok(src.includes("queueMicrotask"));
    assert.ok(src.includes("isTelemetryEnabled"));
  });

  it("useTrackingCoordinator exposes bounded trace buffer without changing FLUSH_MAX_MS", () => {
    const src = readFe("hooks/useTrackingCoordinator.js");
    assert.ok(src.includes("const FLUSH_MAX_MS = 300"));
    assert.ok(src.includes("getCoordinatorTrace"));
    assert.ok(src.includes("TRACE_MAX"));
    assert.ok(src.includes("rehydrate_start"));
    assert.ok(src.includes("source_switch"));
  });

  it("rating batch hook records telemetry without changing /reviews/summary path", () => {
    const src = readFe("hooks/useRatingSummaryBatch.js");
    assert.ok(src.includes("/reviews/summary"));
    assert.ok(src.includes("recordRatingBatchRequest"));
    assert.ok(!src.includes("/reviews/${"));
  });
});

describe("Phase 4 — distributed safety (frontend)", () => {
  it("tracking event contract defines eventId + timestamp arbitration", () => {
    const src = readFe("utils/trackingEventContract.js");
    assert.ok(src.includes("eventId"));
    assert.ok(src.includes("shouldAcceptTrackingEvent"));
    assert.ok(src.includes("lastTimestampByShipment"));
  });

  it("event dedupe cache is LRU with TTL", () => {
    const src = readFe("utils/eventDedupeCache.js");
    assert.ok(src.includes("createEventDedupeCache"));
    assert.ok(src.includes("ttlMs"));
    assert.ok(src.includes("maxEntries"));
  });

  it("useShipmentTracking applies dedupe before scheduleBufferedUpdate", () => {
    const src = readFe("hooks/useShipmentTracking.js");
    assert.ok(src.includes("shouldAcceptTrackingEvent"));
    assert.ok(src.includes("rememberTrackingEvent"));
    assert.ok(src.includes("useTrackingCoordinator"));
    assert.ok(src.includes("scheduleBufferedUpdate"));
  });

  it("AppContext blocks duplicate tracking eventId at socket ingress", () => {
    const src = readFe("context/AppContext.jsx");
    assert.ok(src.includes("normalizeTrackingEvent"));
    assert.ok(src.includes("trackingEventDedupeCache.has"));
  });
});

describe("Phase 4 — notification dedupe adapter (backend)", () => {
  it("adapter module exposes InMemory and Redis adapters", async () => {
    const adapter = require("../utils/notificationDedupeAdapter");
    assert.equal(typeof adapter.createNotificationDedupeAdapter, "function");
    assert.equal(typeof adapter.InMemoryAdapter, "function");
    assert.equal(typeof adapter.RedisAdapter, "function");
    const mem = new adapter.InMemoryAdapter(5000);
    await mem.set("k1");
    assert.equal(await mem.has("k1"), true);
  });

  it("notifyEvent uses createNotificationDedupeAdapter", () => {
    const src = read("utils/notifyEvent.js");
    assert.ok(src.includes("createNotificationDedupeAdapter"));
    assert.ok(!src.includes("const memoryDedupe = new Map()"));
  });
});

describe("Phase 4 — list virtualization compatibility", () => {
  it("VirtualListBody keeps render-only virtualization", () => {
    const src = readFe("components/ui/VirtualListBody.jsx");
    assert.ok(src.includes("isVirtualListEnabled"));
    assert.ok(src.includes("VITE_VIRTUAL_LISTS"));
    assert.ok(!src.includes("useRatingSummaryBatch"));
    assert.ok(!src.includes("/reviews/"));
  });

  it("list parents still batch ratings and pass ratingMap", () => {
    for (const file of [
      "components/loadboard/BidList.jsx",
      "components/loadboard/LoadList.jsx",
      "components/carrier/CapacityMarketplace.jsx"
    ]) {
      const src = readFe(file);
      assert.ok(src.includes("useRatingSummaryBatch"), file);
      assert.ok(src.includes("ratingMap"), file);
      assert.ok(src.includes("VirtualListBody"), file);
      assert.ok(!src.includes("useReceivedRatingSummary"), file);
    }
  });
});

describe("Phase 4 — Phase 3 invariant preservation", () => {
  it("UserRatingBadge remains lookup-only", () => {
    const src = readFe("components/reviews/UserRatingBadge.jsx");
    assert.ok(src.includes("lookupRatingSummary"));
    assert.ok(!src.includes("useReceivedRatingSummary"));
    assert.ok(!src.includes("useApi"));
  });

  it("ShipmentTracking page has no duplicate refresh listeners", () => {
    const src = readFe("pages/shipments/ShipmentTracking.jsx");
    assert.ok(!src.includes("tp:tracking-refresh"));
    assert.ok(!src.includes("tp:shipments-refresh"));
    assert.ok(!src.includes("tp:realtime-refresh"));
  });
});
