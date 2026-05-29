/**
 * Phase 7 — Bid/load state machine invariants (unit, no HTTP).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { BID, assertBidTransition, normalizeBidStatus } = require("../utils/bidStateMachine");

describe("Phase 7 — bid state machine", () => {
  it("terminal states allow no further transitions", () => {
    for (const terminal of [BID.ACCEPTED, BID.REJECTED, BID.CANCELLED]) {
      assert.throws(
        () => assertBidTransition(terminal, BID.PENDING_SHIPPER),
        (e) => e.code === "INVALID_BID_TRANSITION"
      );
    }
  });

  it("rejected cannot transition to accepted (no reopen)", () => {
    assert.throws(
      () => assertBidTransition(BID.REJECTED, BID.ACCEPTED),
      (e) => e.code === "INVALID_BID_TRANSITION"
    );
  });

  it("accepted cannot transition to rejected", () => {
    assert.throws(
      () => assertBidTransition(BID.ACCEPTED, BID.REJECTED),
      (e) => e.code === "INVALID_BID_TRANSITION"
    );
  });

  it("pending shipper can reach accepted or rejected", () => {
    assert.doesNotThrow(() => assertBidTransition(BID.PENDING_SHIPPER, BID.ACCEPTED));
    assert.doesNotThrow(() => assertBidTransition(BID.PENDING_SHIPPER, BID.REJECTED));
    assert.doesNotThrow(() => assertBidTransition(BID.PENDING_SHIPPER, BID.COUNTER));
  });

  it("normalizeBidStatus maps legacy aliases", () => {
    assert.equal(normalizeBidStatus("pending"), BID.PENDING_SHIPPER);
    assert.equal(normalizeBidStatus("countered"), BID.COUNTER);
    assert.equal(normalizeBidStatus("rejected"), BID.REJECTED);
  });
});

describe("Phase 7 — matching engine closed bids", () => {
  it("validateBidPlacement blocks rejected bid reuse", async () => {
    const { validateBidPlacement } = require("../utils/matchingEngine");
    const load = {
      status: "open",
      weight: 10,
      vehicle_type: "Truck",
      deadline_minutes: 360,
      created_at: new Date()
    };
    const result = await validateBidPlacement({
      carrierUserId: "00000000-0000-4000-8000-000000000001",
      load,
      existingBid: { status: "rejected", amount: 1000 }
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "BID_CLOSED");
  });
});
