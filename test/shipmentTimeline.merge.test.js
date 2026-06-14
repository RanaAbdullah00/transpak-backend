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
    assert.ok(events.some((ev) => ev.status === "closed"));
  });
});
