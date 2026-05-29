const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeTruckStatus,
  isApprovedForMatching,
  apiTruckStatus,
  hasRequiredDocuments,
  TRUCK_STATUS
} = require("../utils/truckLifecycle");
const { fleetMatchesLoad } = require("../utils/matchingEngine");

describe("fleet lifecycle — status", () => {
  it("maps legacy active to approved", () => {
    assert.equal(normalizeTruckStatus("active"), TRUCK_STATUS.APPROVED);
    assert.equal(isApprovedForMatching("active"), true);
  });

  it("pending is not matching eligible", () => {
    assert.equal(isApprovedForMatching("pending"), false);
    assert.equal(isApprovedForMatching("pending_verification"), false);
  });

  it("suspended is not matching eligible", () => {
    assert.equal(isApprovedForMatching("suspended"), false);
  });

  it("api labels", () => {
    assert.equal(apiTruckStatus("approved"), "APPROVED");
    assert.equal(apiTruckStatus("pending"), "PENDING");
  });
});

describe("fleet lifecycle — documents", () => {
  it("requires front and back card images", () => {
    assert.equal(hasRequiredDocuments({ truckCardFrontImage: "https://x/a.jpg" }), false);
    assert.equal(
      hasRequiredDocuments({
        truckCardFrontImage: "https://x/a.jpg",
        truckCardBackImage: "https://x/b.jpg"
      }),
      true
    );
  });
});

describe("fleet lifecycle — matching uses approved fleet only", () => {
  it("rejects fleet with zero approved trucks", () => {
    const r = fleetMatchesLoad(
      { truckTypes: [], maxCapacityTons: 0, truckCount: 0 },
      { vehicle_type: "Truck", weight: 1 }
    );
    assert.equal(r.ok, false);
    assert.equal(r.code, "FLEET_REQUIRED");
  });

  it("pending trucks in profile do not count as truckCount for matching", () => {
    const r = fleetMatchesLoad(
      { truckTypes: ["flatbed"], maxCapacityTons: 20, truckCount: 0 },
      { vehicle_type: "Flatbed", weight: 10 }
    );
    assert.equal(r.ok, false);
    assert.equal(r.code, "FLEET_REQUIRED");
  });
});
