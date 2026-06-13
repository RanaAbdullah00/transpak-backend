const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { isSystemInSync, getDriftReport, invalidateDriftCache } = require("../utils/runtimeIntegrityGuard");

describe("runtimeIntegrityGuard", () => {
  it("isSystemInSync when no expected env constraints", () => {
    invalidateDriftCache();
    const prevCommit = process.env.EXPECTED_DEPLOY_COMMIT;
    const prevFlag = process.env.EXPECTED_ALLOW_VEHICLE_TYPE_MISMATCH;
    delete process.env.EXPECTED_DEPLOY_COMMIT;
    delete process.env.EXPECTED_ALLOW_VEHICLE_TYPE_MISMATCH;
    try {
      invalidateDriftCache();
      assert.equal(isSystemInSync(), true);
      const report = getDriftReport();
      assert.equal(report.systemDrift, false);
      assert.ok(Array.isArray(report.drifts));
    } finally {
      if (prevCommit === undefined) delete process.env.EXPECTED_DEPLOY_COMMIT;
      else process.env.EXPECTED_DEPLOY_COMMIT = prevCommit;
      if (prevFlag === undefined) delete process.env.EXPECTED_ALLOW_VEHICLE_TYPE_MISMATCH;
      else process.env.EXPECTED_ALLOW_VEHICLE_TYPE_MISMATCH = prevFlag;
      invalidateDriftCache();
    }
  });

  it("detects commit drift when EXPECTED_DEPLOY_COMMIT mismatches", () => {
    invalidateDriftCache();
    const prev = process.env.EXPECTED_DEPLOY_COMMIT;
    process.env.EXPECTED_DEPLOY_COMMIT = "deadbeef00000000000000000000000000000000";
    try {
      invalidateDriftCache();
      const report = getDriftReport();
      assert.equal(report.systemDrift, true);
      assert.equal(isSystemInSync(), false);
      assert.ok(report.drifts.some((d) => d.type === "commit"));
    } finally {
      if (prev === undefined) delete process.env.EXPECTED_DEPLOY_COMMIT;
      else process.env.EXPECTED_DEPLOY_COMMIT = prev;
      invalidateDriftCache();
    }
  });

  it("detects invalid feature flag values", () => {
    invalidateDriftCache();
    const prev = process.env.ALLOW_VEHICLE_TYPE_MISMATCH;
    process.env.ALLOW_VEHICLE_TYPE_MISMATCH = "maybe";
    try {
      invalidateDriftCache();
      const report = getDriftReport();
      assert.equal(report.systemDrift, true);
      assert.ok(report.drifts.some((d) => d.type === "flag_validation"));
    } finally {
      if (prev === undefined) delete process.env.ALLOW_VEHICLE_TYPE_MISMATCH;
      else process.env.ALLOW_VEHICLE_TYPE_MISMATCH = prev;
      invalidateDriftCache();
    }
  });
});

describe("runtimeIntegrityGuard — SAFE MODE coupling", () => {
  it("policyEngine enforces STRICT when drift detected", () => {
    const prev = process.env.EXPECTED_DEPLOY_COMMIT;
    const prevRelaxed = process.env.ALLOW_VEHICLE_TYPE_MISMATCH;
    process.env.EXPECTED_DEPLOY_COMMIT = "deadbeef00000000000000000000000000000000";
    process.env.ALLOW_VEHICLE_TYPE_MISMATCH = "true";
    try {
      invalidateDriftCache();
      const { getVehicleMatchMode, shouldAllowBid, isSafeModeActive } = require("../utils/policyEngine");
      assert.equal(isSafeModeActive(), true);
      assert.equal(getVehicleMatchMode(), "STRICT");
      const r = shouldAllowBid(
        { truckTypes: ["Mazda"], maxCapacityTons: 10, truckCount: 1 },
        { vehicle_type: "Reefer", weight: 5 }
      );
      assert.equal(r.ok, false);
      assert.equal(r.code, "VEHICLE_TYPE_MISMATCH");
    } finally {
      if (prev === undefined) delete process.env.EXPECTED_DEPLOY_COMMIT;
      else process.env.EXPECTED_DEPLOY_COMMIT = prev;
      if (prevRelaxed === undefined) delete process.env.ALLOW_VEHICLE_TYPE_MISMATCH;
      else process.env.ALLOW_VEHICLE_TYPE_MISMATCH = prevRelaxed;
      invalidateDriftCache();
    }
  });
});
