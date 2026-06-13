const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  shouldAllowLoad,
  shouldAllowBid,
  shouldFilterLoadsByVehicle,
  getVehicleMatchMode,
  validateLoginRoleHint,
  getPolicyHealthSnapshot
} = require("../utils/policyEngine");

describe("policyEngine — vehicle match", () => {
  it("STRICT blocks mismatched bid", () => {
    const prev = process.env.ALLOW_VEHICLE_TYPE_MISMATCH;
    delete process.env.ALLOW_VEHICLE_TYPE_MISMATCH;
    try {
      assert.equal(getVehicleMatchMode(), "STRICT");
      const r = shouldAllowBid(
        { truckTypes: ["Mazda"], maxCapacityTons: 10, truckCount: 1 },
        { vehicle_type: "Reefer", weight: 5 }
      );
      assert.equal(r.ok, false);
      assert.equal(r.code, "VEHICLE_TYPE_MISMATCH");
    } finally {
      if (prev === undefined) delete process.env.ALLOW_VEHICLE_TYPE_MISMATCH;
      else process.env.ALLOW_VEHICLE_TYPE_MISMATCH = prev;
    }
  });

  it("RELAXED allows bid with warning and shows load in listing", () => {
    const prev = process.env.ALLOW_VEHICLE_TYPE_MISMATCH;
    process.env.ALLOW_VEHICLE_TYPE_MISMATCH = "true";
    try {
      assert.equal(getVehicleMatchMode(), "RELAXED");
      assert.equal(shouldFilterLoadsByVehicle(), false);
      const bid = shouldAllowBid(
        { truckTypes: ["Mazda"], maxCapacityTons: 10, truckCount: 1 },
        { vehicle_type: "Reefer", weight: 5 }
      );
      assert.equal(bid.ok, true);
      assert.equal(bid.vehicleTypeMismatchWarning, true);
      const load = shouldAllowLoad(
        { truckTypes: ["Mazda"], maxCapacityTons: 10 },
        { vehicle_type: "Reefer", weight: 5 }
      );
      assert.equal(load.ok, true);
    } finally {
      if (prev === undefined) delete process.env.ALLOW_VEHICLE_TYPE_MISMATCH;
      else process.env.ALLOW_VEHICLE_TYPE_MISMATCH = prev;
    }
  });
});

describe("policyEngine — login RBAC", () => {
  it("WRONG_ROLE when hint not in commercial roles", () => {
    const r = validateLoginRoleHint({ roles: ["shipper"] }, "carrier");
    assert.equal(r.ok, false);
    assert.equal(r.code, "WRONG_ROLE");
    assert.equal(r.message, "Invalid account type for selected role");
  });

  it("ROLE_SELECTION_REQUIRED for dual-role without hint", () => {
    const r = validateLoginRoleHint({ roles: ["shipper", "carrier"] }, "");
    assert.equal(r.ok, false);
    assert.equal(r.code, "ROLE_SELECTION_REQUIRED");
  });
});

describe("policyEngine — policy health snapshot", () => {
  it("includes required deployment fields", () => {
    const snap = getPolicyHealthSnapshot();
    assert.ok(snap.commit);
    assert.ok(snap.featureFlags);
    assert.ok(["STRICT", "RELAXED"].includes(snap.vehicleMatchMode));
    assert.ok(snap.roleEnforcementVersion);
    assert.ok(snap.notificationGuardVersion);
    assert.ok(snap.runtimeDrift);
    assert.equal(typeof snap.safeMode, "boolean");
  });
});
