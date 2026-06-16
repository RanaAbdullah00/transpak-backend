const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildEventDedupeKey,
  buildLegacyContentDedupeKey
} = require("../utils/notificationDedupeAdapter");
const { resolveNotificationDedupeKey } = require("../utils/notifyEvent");

describe("notification event-safe dedupe keys", () => {
  it("builds distinct keys per bidId for BID_ACCEPTED", () => {
    const bidA = buildEventDedupeKey("BID_ACCEPTED", "bid-1", "carrier-1");
    const bidB = buildEventDedupeKey("BID_ACCEPTED", "bid-2", "carrier-1");
    assert.notEqual(bidA, bidB);
    assert.ok(bidA.includes("BID_ACCEPTED"));
    assert.ok(bidA.includes("bid-1"));
  });

  it("is idempotent for same event + entity + receiver", () => {
    const a = buildEventDedupeKey("BID_ACCEPTED", "bid-1", "carrier-1");
    const b = buildEventDedupeKey("BID_ACCEPTED", "bid-1", "carrier-1");
    assert.equal(a, b);
  });

  it("never dedupes across event types on same entity", () => {
    const accepted = buildEventDedupeKey("BID_ACCEPTED", "bid-1", "user-1");
    const contract = buildEventDedupeKey("CONTRACT_STARTED", "bid-1", "user-1");
    assert.notEqual(accepted, contract);
  });

  it("uses eventVersion for shipment status transitions", () => {
    const picked = buildEventDedupeKey("SHIPMENT_PICKED_UP", "ship-1", "user-1", "pickedup");
    const transit = buildEventDedupeKey("SHIPMENT_IN_TRANSIT", "ship-1", "user-1", "intransit");
    assert.notEqual(picked, transit);
  });

  it("legacy content key differs from event-safe key", () => {
    const legacy = buildLegacyContentDedupeKey(
      "carrier-1",
      "BID_ACCEPTED",
      "Your bid was accepted. Contract is active."
    );
    const eventSafe = buildEventDedupeKey("BID_ACCEPTED", "bid-99", "carrier-1");
    assert.notEqual(legacy, eventSafe);
  });

  it("resolveNotificationDedupeKey prefers entityId over content hash", () => {
    const key = resolveNotificationDedupeKey({
      eventType: "BID_ACCEPTED",
      receiverId: "carrier-1",
      title: "BID_ACCEPTED",
      message: "Your bid was accepted. Contract is active.",
      entityId: "bid-42"
    });
    assert.equal(key, buildEventDedupeKey("BID_ACCEPTED", "bid-42", "carrier-1"));
  });

  it("simulates bid accepted → shipment status → distinct keys", () => {
    const accept = buildEventDedupeKey("BID_ACCEPTED", "bid-1", "carrier-1");
    const shipment = buildEventDedupeKey("SHIPMENT_PICKED_UP", "ship-1", "carrier-1", "pickedup");
    const contract = buildEventDedupeKey("CONTRACT_STARTED", "bid-1", "shipper-1");
    const keys = new Set([accept, shipment, contract]);
    assert.equal(keys.size, 3);
  });
});
