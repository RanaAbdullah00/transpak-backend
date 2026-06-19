const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { buildDedupeKey, DISPATCH_TYPES } = require("../utils/realtimeDispatch");
const { notificationScopeClause } = require("../utils/notificationScope");

describe("realtime dispatch — dedupe keys", () => {
  it("builds stable dedupe keys", () => {
    const a = buildDedupeKey(["BID_RECEIVED", "load-1", "user-2"]);
    const b = buildDedupeKey(["BID_RECEIVED", "load-1", "user-2"]);
    assert.equal(a, b);
    assert.ok(a.includes("BID_RECEIVED"));
  });

  it("exports dispatch types", () => {
    assert.equal(DISPATCH_TYPES.LOAD_POSTED, "LOAD_POSTED");
    assert.equal(DISPATCH_TYPES.COUNTER_OFFERED, "COUNTER_OFFERED");
  });
});

describe("notification scope — workspace isolation", () => {
  it("scopes to active workspace when provided", () => {
    const scope = notificationScopeClause(
      { roles: ["shipper", "carrier"] },
      "carrier",
      2
    );
    assert.ok(scope.sql.includes("$2"));
    assert.deepEqual(scope.params, ["carrier"]);
  });

  it("fails closed for dual commercial when workspace omitted", () => {
    const scope = notificationScopeClause({ roles: ["shipper", "carrier"] }, null, 2);
    assert.equal(scope.sql, "FALSE");
    assert.deepEqual(scope.params, []);
  });
});
