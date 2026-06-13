const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  fleetMatchesLoad,
  normalizeVehicleType,
  loadIsBiddingEligible,
  validateBidPlacement,
  validateCounterBid,
  buildCarrierMatchSql,
  shouldFilterLoadsByVehicle
} = require("../utils/matchingEngine");
const { BID } = require("../utils/bidStateMachine");

describe("matching engine — fleet rules", () => {
  it("normalizes vehicle types for comparison", () => {
    assert.equal(normalizeVehicleType("  Flatbed  "), "flatbed");
  });

  it("rejects when fleet has no matching vehicle type", () => {
    const r = fleetMatchesLoad(
      { truckTypes: ["Mazda"], maxCapacityTons: 10, truckCount: 1 },
      { vehicle_type: "Reefer", weight: 5 }
    );
    assert.equal(r.ok, false);
    assert.equal(r.code, "VEHICLE_TYPE_MISMATCH");
  });

  it("rejects when load weight exceeds fleet capacity", () => {
    const r = fleetMatchesLoad(
      { truckTypes: ["flatbed"], maxCapacityTons: 8, truckCount: 1 },
      { vehicle_type: "Flatbed", weight: 12 }
    );
    assert.equal(r.ok, false);
    assert.equal(r.code, "CAPACITY_EXCEEDED");
  });

  it("accepts matching fleet and load", () => {
    const r = fleetMatchesLoad(
      { truckTypes: ["Container"], maxCapacityTons: 25, truckCount: 2 },
      { vehicle_type: "container", weight: 20 }
    );
    assert.equal(r.ok, true);
  });

  it("warns but allows mismatch when ALLOW_VEHICLE_TYPE_MISMATCH=true", () => {
    const prev = process.env.ALLOW_VEHICLE_TYPE_MISMATCH;
    process.env.ALLOW_VEHICLE_TYPE_MISMATCH = "true";
    try {
      const r = fleetMatchesLoad(
        { truckTypes: ["Mazda"], maxCapacityTons: 10, truckCount: 1 },
        { vehicle_type: "Reefer", weight: 5 }
      );
      assert.equal(r.ok, true);
      assert.equal(r.vehicleTypeMismatchWarning, true);
      assert.equal(r.warningCode, "VEHICLE_TYPE_MISMATCH");
    } finally {
      if (prev === undefined) delete process.env.ALLOW_VEHICLE_TYPE_MISMATCH;
      else process.env.ALLOW_VEHICLE_TYPE_MISMATCH = prev;
    }
  });
});

describe("matching engine — vehicle policy", () => {
  it("shouldFilterLoadsByVehicle is false when flag relaxed", () => {
    const prev = process.env.ALLOW_VEHICLE_TYPE_MISMATCH;
    process.env.ALLOW_VEHICLE_TYPE_MISMATCH = "true";
    try {
      assert.equal(shouldFilterLoadsByVehicle(), false);
      const sql = buildCarrierMatchSql({ truckTypes: ["Truck"], maxCapacityTons: 10 }, 1);
      assert.equal(sql.clauses.some((c) => c.includes("vehicle_type")), false);
    } finally {
      if (prev === undefined) delete process.env.ALLOW_VEHICLE_TYPE_MISMATCH;
      else process.env.ALLOW_VEHICLE_TYPE_MISMATCH = prev;
    }
  });

  it("shouldFilterLoadsByVehicle is true when flag strict", () => {
    const prev = process.env.ALLOW_VEHICLE_TYPE_MISMATCH;
    delete process.env.ALLOW_VEHICLE_TYPE_MISMATCH;
    try {
      assert.equal(shouldFilterLoadsByVehicle(), true);
      const sql = buildCarrierMatchSql({ truckTypes: ["Truck"], maxCapacityTons: 10 }, 1);
      assert.equal(sql.clauses.some((c) => c.includes("vehicle_type")), true);
    } finally {
      if (prev === undefined) delete process.env.ALLOW_VEHICLE_TYPE_MISMATCH;
      else process.env.ALLOW_VEHICLE_TYPE_MISMATCH = prev;
    }
  });
});

describe("matching engine — bidding window", () => {
  it("loadIsBiddingEligible false when status not open", () => {
    assert.equal(loadIsBiddingEligible({ status: "booked", created_at: new Date() }), false);
  });

  it("loadIsBiddingEligible false when deadline passed", () => {
    const created = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    assert.equal(
      loadIsBiddingEligible({ status: "open", created_at: created, deadline_hours: 1 }),
      false
    );
  });
});

describe("matching engine — bid placement", () => {
  it("blocks reopening rejected bids", async () => {
    const r = await validateBidPlacement({
      carrierUserId: "00000000-0000-4000-8000-000000000099",
      load: { status: "open", vehicle_type: "Truck", weight: 1, created_at: new Date(), deadline_hours: 24 },
      existingBid: { status: BID.REJECTED }
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "BID_CLOSED");
  });

  it("blocks duplicate active bid", async () => {
    const r = await validateBidPlacement({
      carrierUserId: "00000000-0000-4000-8000-000000000099",
      load: { status: "open", vehicle_type: "Truck", weight: 1, created_at: new Date(), deadline_hours: 24 },
      existingBid: { status: BID.COUNTER }
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "ACTIVE_BID_EXISTS");
  });
});

describe("matching engine — counter bids", () => {
  it("blocks counter on rejected bid", async () => {
    const load = {
      status: "open",
      vehicle_type: "Truck",
      weight: 1,
      created_at: new Date(),
      deadline_hours: 24
    };
    const r = await validateCounterBid({
      actorRole: "shipper",
      carrierUserId: "c1",
      bid: { status: BID.REJECTED },
      load
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "BID_CLOSED");
  });
});
