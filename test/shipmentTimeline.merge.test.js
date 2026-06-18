/**
 * Phase 2 — mergeShipmentTimelineEvents terminal status authority.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("url");

const optimisticPath = path.join(
  __dirname,
  "..",
  "..",
  "transpak-frontend",
  "src",
  "utils",
  "shipmentStatusOptimistic.js"
);

describe("mergeShipmentTimelineEvents", () => {
  it("terminal closed wins over stale intransit history", async () => {
    const mod = await import(pathToFileURL(optimisticPath).href);
    const { mergeShipmentTimelineEvents, commitOptimisticStatusAdvance } = mod;
    const ref = `TEST-MERGE-${Date.now()}`;
    commitOptimisticStatusAdvance(ref, "closed", { label: "Closed" });
    const { events, effectiveStatus } = mergeShipmentTimelineEvents(
      ref,
      [{ event: "intransit", time: "2024-01-01T00:00:00.000Z", status: "intransit" }],
      { apiStatus: "intransit" }
    );
    assert.equal(effectiveStatus, "closed");
    assert.ok(events.every((ev) => ["booked", "pickedup", "intransit", "delivered"].includes(ev.status)));
  });

  it("dedupeTimelineEvents collapses duplicate status rows", async () => {
    const mod = await import(pathToFileURL(optimisticPath).href);
    const { dedupeTimelineEvents } = mod;
    const ts = "2024-06-01T12:00:00.000Z";
    const out = dedupeTimelineEvents([
      { event: "booked", time: ts, status: "booked" },
      { event: "Status: booked", time: ts, status: "booked" },
      { event: "intransit", time: "2024-06-01T14:00:00.000Z", status: "intransit" }
    ]);
    assert.equal(out.length, 2);
  });
});
