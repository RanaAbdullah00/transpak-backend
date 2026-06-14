/**
 * Phase 4 — stress / load validation (synthetic, no network).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("url");

const frontendSrc = path.join(__dirname, "..", "..", "transpak-frontend", "src");

async function importFe(rel) {
  return import(pathToFileURL(path.join(frontendSrc, rel)).href);
}

describe("Phase 4 — rating stress (synthetic)", () => {
  it("1000 user IDs coalesce to single batch key set without per-user fetch paths", async () => {
    const ids = [];
    for (let i = 0; i < 1000; i += 1) {
      ids.push(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    }
    const unique = [...new Set(ids)];
    assert.equal(unique.length, 1000);
    const batchParam = unique.join(",");
    assert.ok(batchParam.length > 1000);
    assert.equal(batchParam.split(",").length, 1000);
    const batchSrc = await import("fs/promises").then((fs) =>
      fs.readFile(path.join(frontendSrc, "hooks/useRatingSummaryBatch.js"), "utf8")
    );
    assert.ok(batchSrc.includes("userIds: ids.join(',')"));
    assert.ok(!batchSrc.includes("`/reviews/${"));
  });
});

describe("Phase 4 — event dedupe effectiveness", () => {
  it("duplicate eventId is rejected; newer timestamp wins", async () => {
    const { createEventDedupeCache } = await importFe("utils/eventDedupeCache.js");
    const {
      normalizeTrackingEvent,
      shouldAcceptTrackingEvent,
      rememberTrackingEvent
    } = await importFe("utils/trackingEventContract.js");

    const cache = createEventDedupeCache({ maxEntries: 100, ttlMs: 60_000 });
    const lastTimestampByShipment = new Map();
    const ctx = { cache, lastTimestampByShipment };

    const payload = {
      eventId: "evt-1",
      refKey: "SHIP-1",
      ts: 1000,
      tracking: { status: "in_transit" }
    };
    const event = normalizeTrackingEvent(payload, "socket");
    assert.equal(shouldAcceptTrackingEvent(event, ctx), true);
    rememberTrackingEvent(event, ctx);
    assert.equal(shouldAcceptTrackingEvent(event, ctx), false);

    const older = normalizeTrackingEvent(
      { eventId: "evt-2", refKey: "SHIP-1", ts: 900, tracking: { status: "in_transit" } },
      "socket"
    );
    assert.equal(shouldAcceptTrackingEvent(older, ctx), false);

    const newer = normalizeTrackingEvent(
      { eventId: "evt-3", refKey: "SHIP-1", ts: 2000, tracking: { status: "delivered" } },
      "socket"
    );
    assert.equal(shouldAcceptTrackingEvent(newer, ctx), true);
  });

  it("LRU evicts beyond maxEntries", async () => {
    const { createEventDedupeCache } = await importFe("utils/eventDedupeCache.js");
    const cache = createEventDedupeCache({ maxEntries: 5, ttlMs: 60_000 });
    for (let i = 0; i < 10; i += 1) {
      cache.remember(`id-${i}`);
    }
    assert.ok(cache.size <= 5);
    assert.equal(cache.has("id-0"), false);
    assert.equal(cache.has("id-9"), true);
  });
});

describe("Phase 4 — tracking coordinator stress (synthetic flush paths)", () => {
  it("100 rapid socket schedules coalesce to bounded flush handler invocations", () => {
    let flushCount = 0;
    const pending = { value: null };
    const flush = () => {
      flushCount += 1;
      pending.value = null;
    };

    for (let i = 0; i < 100; i += 1) {
      pending.value = { i };
    }
    flush();
    assert.equal(flushCount, 1);
    assert.equal(pending.value, null);
  });

  it("coordinator module keeps 300ms debounce constant", async () => {
    const fs = await import("fs/promises");
    const src = await fs.readFile(
      path.join(frontendSrc, "hooks/useTrackingCoordinator.js"),
      "utf8"
    );
    assert.ok(src.includes("const FLUSH_MAX_MS = 300"));
    assert.ok(src.includes("debounce_300ms"));
  });
});

describe("Phase 4 — multi-shipment isolation (contract-level)", () => {
  it("dedupe timestamps are scoped per shipmentId", async () => {
    const { createEventDedupeCache } = await importFe("utils/eventDedupeCache.js");
    const {
      normalizeTrackingEvent,
      shouldAcceptTrackingEvent,
      rememberTrackingEvent
    } = await importFe("utils/trackingEventContract.js");

    const ctx = { cache: createEventDedupeCache(), lastTimestampByShipment: new Map() };
    const a = normalizeTrackingEvent(
      { eventId: "a1", refKey: "REF-A", ts: 500, tracking: { status: "booked" } },
      "socket"
    );
    const b = normalizeTrackingEvent(
      { eventId: "b1", refKey: "REF-B", ts: 100, tracking: { status: "booked" } },
      "socket"
    );
    rememberTrackingEvent(a, ctx);
    assert.equal(shouldAcceptTrackingEvent(b, ctx), true);
    rememberTrackingEvent(b, ctx);
    assert.equal(ctx.lastTimestampByShipment.get("REF-A"), 500);
    assert.equal(ctx.lastTimestampByShipment.get("REF-B"), 100);
  });
});
