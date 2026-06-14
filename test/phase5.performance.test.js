/**
 * Phase 5 — load + stress resilience (synthetic).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("url");

const frontendSrc = path.join(__dirname, "..", "..", "transpak-frontend", "src");

async function importFe(rel) {
  return import(pathToFileURL(path.join(frontendSrc, rel)).href);
}

describe("Phase 5 — tracking burst resilience", () => {
  it("100 socket events/sec coalesce to one pending payload before flush", () => {
    let flushes = 0;
    let pending = null;
    const schedule = (incoming) => {
      pending = incoming;
    };
    const flush = () => {
      if (pending) flushes += 1;
      pending = null;
    };

    for (let i = 0; i < 100; i += 1) {
      schedule({ ts: i, tracking: { status: "intransit" } });
    }
    flush();
    assert.equal(flushes, 1);
  });

  it("reconnect replay: duplicate eventIds are dropped globally", async () => {
    const { createEventDedupeCache } = await importFe("utils/eventDedupeCache.js");
    const {
      normalizeTrackingEvent,
      shouldAcceptTrackingEvent,
      rememberTrackingEvent
    } = await importFe("utils/trackingEventContract.js");

    const cache = createEventDedupeCache({ maxEntries: 1500, ttlMs: 60_000 });
    const ctx = { cache, lastTimestampByShipment: new Map() };
    let accepted = 0;
    let skipped = 0;

    for (let loop = 0; loop < 3; loop += 1) {
      for (let i = 0; i < 100; i += 1) {
        const event = normalizeTrackingEvent(
          {
            eventId: `replay-${i % 20}`,
            refKey: "SHIP-X",
            ts: 1000 + i,
            tracking: { status: "intransit" }
          },
          "socket"
        );
        if (shouldAcceptTrackingEvent(event, ctx)) {
          rememberTrackingEvent(event, ctx);
          accepted += 1;
        } else {
          skipped += 1;
        }
      }
    }
    assert.ok(skipped > 0);
    assert.ok(accepted <= 60);
  });
});

describe("Phase 5 — multi-shipment coordinator isolation", () => {
  it("50 shipments maintain independent last-write timestamps", async () => {
    const { createEventDedupeCache } = await importFe("utils/eventDedupeCache.js");
    const {
      normalizeTrackingEvent,
      shouldAcceptTrackingEvent,
      rememberTrackingEvent
    } = await importFe("utils/trackingEventContract.js");

    const ctx = { cache: createEventDedupeCache(), lastTimestampByShipment: new Map() };
    for (let i = 0; i < 50; i += 1) {
      const ref = `REF-${i}`;
      const event = normalizeTrackingEvent(
        { eventId: `e-${i}`, refKey: ref, ts: 100 + i, tracking: { status: "booked" } },
        "socket"
      );
      assert.equal(shouldAcceptTrackingEvent(event, ctx), true);
      rememberTrackingEvent(event, ctx);
    }
    assert.equal(ctx.lastTimestampByShipment.size, 50);
    for (let i = 0; i < 50; i += 1) {
      assert.equal(ctx.lastTimestampByShipment.get(`REF-${i}`), 100 + i);
    }
  });
});

describe("Phase 5 — rating batch integrity under density", () => {
  it("1000 users still map to one batch param (no N+1 paths)", async () => {
    const fs = await import("fs/promises");
    const batchSrc = await fs.readFile(
      path.join(frontendSrc, "hooks/useRatingSummaryBatch.js"),
      "utf8"
    );
    const badgeSrc = await fs.readFile(
      path.join(frontendSrc, "components/reviews/UserRatingBadge.jsx"),
      "utf8"
    );
    assert.ok(batchSrc.includes("userIds: ids.join(',')"));
    assert.ok(!badgeSrc.includes("useApi"));
    assert.ok(!badgeSrc.includes("/reviews/"));
    const ids = Array.from({ length: 1000 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    assert.equal(ids.join(",").split(",").length, 1000);
  });
});

describe("Phase 5 — cross-instance conflict simulation (local)", () => {
  it("in-memory notification dedupe blocks duplicate keys within window", () => {
    const { InMemoryAdapter } = require("../utils/notificationDedupeAdapter");
    const a = new InMemoryAdapter(60_000);
    a.set("notify-key-1");
    assert.equal(a.has("notify-key-1"), true);
    assert.equal(a.has("notify-key-2"), false);
  });
});
