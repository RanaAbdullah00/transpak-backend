/**
 * Backend role isolation enforcement — unit + integration.
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveCommercialWorkspace,
  shipmentPartySql,
  normalizeWorkspace
} = require("../utils/commercialWorkspace");
const { notificationScopeClause } = require("../utils/notificationScope");
const { integrationSuiteSkipReason, hasDualRoleEnv, skipDualRoleReason, requireLocalTestServerReason } = require("./helpers/config");
const { api, login } = require("./helpers/http");

function mockReq({ roles = [], activeRole = null, headers = {}, query = {} } = {}) {
  return {
    auth: { roles, userId: "user-1" },
    user: { activeRole },
    headers,
    query
  };
}

describe("commercialWorkspace — resolveCommercialWorkspace", () => {
  it("single shipper resolves without header", () => {
    const { workspace, error } = resolveCommercialWorkspace(mockReq({ roles: ["shipper"] }));
    assert.equal(workspace, "shipper");
    assert.equal(error, null);
  });

  it("dual commercial requires workspace when DB active missing", () => {
    const { workspace, error } = resolveCommercialWorkspace(
      mockReq({ roles: ["shipper", "carrier"] })
    );
    assert.equal(workspace, null);
    assert.equal(error, "WORKSPACE_REQUIRED");
  });

  it("dual commercial accepts validated header", () => {
    const { workspace, error } = resolveCommercialWorkspace(
      mockReq({
        roles: ["shipper", "carrier"],
        headers: { "x-transpak-workspace": "carrier" }
      })
    );
    assert.equal(workspace, "carrier");
    assert.equal(error, null);
  });

  it("rejects mismatched workspace for single-role shipper", () => {
    const { workspace, error } = resolveCommercialWorkspace(
      mockReq({
        roles: ["shipper"],
        headers: { "x-transpak-workspace": "carrier" }
      })
    );
    assert.equal(workspace, null);
    assert.equal(error, "FORBIDDEN_WORKSPACE");
  });

  it("rejects conflicting header and query workspace", () => {
    const { workspace, error } = resolveCommercialWorkspace(
      mockReq({
        roles: ["shipper", "carrier"],
        headers: { "x-transpak-workspace": "shipper" },
        query: { workspace: "carrier" }
      })
    );
    assert.equal(workspace, null);
    assert.equal(error, "FORBIDDEN_WORKSPACE");
  });

  it("uses DB active_role for dual commercial when no header", () => {
    const { workspace, error } = resolveCommercialWorkspace(
      mockReq({ roles: ["shipper", "carrier"], activeRole: "shipper" })
    );
    assert.equal(workspace, "shipper");
    assert.equal(error, null);
  });
});

describe("commercialWorkspace — shipmentPartySql", () => {
  it("scopes shipper party filter", () => {
    assert.equal(shipmentPartySql("shipper"), "l.shipper_id = $1");
  });

  it("scopes carrier party filter", () => {
    assert.equal(shipmentPartySql("carrier"), "l.assigned_carrier_id = $1");
  });
});

describe("notification scope — dual role fail closed", () => {
  it("returns FALSE without workspace", () => {
    const scope = notificationScopeClause({ roles: ["shipper", "carrier"] }, null, 2);
    assert.equal(scope.sql, "FALSE");
  });
});

describe(
  "Role isolation — HTTP enforcement",
  {
    skip:
      requireLocalTestServerReason() ||
      (hasDualRoleEnv() ? false : skipDualRoleReason())
  },
  () => {
    let token;
    const stamp = Date.now();

    before(async () => {
      const email = process.env.E2E_DUAL_EMAIL || "transpak.phase1.dual@example.com";
      const password = process.env.PHASE1_RBAC_PASSWORD || process.env.E2E_SHIPPER_PASSWORD;
      const session = await login(email, password, "shipper");
      token = session.token;
      assert.ok(token);
    });

    it("dual user without header uses persisted active_role workspace", async () => {
      const res = await api("GET", "/api/notifications/unread-count", { token });
      assert.ok(res.ok, res.message);
      assert.equal(typeof res.payload?.count, "number");
    });

    it("shipper workspace excludes carrier notifications", async () => {
      const { insertTestNotification, findUserIdByEmail, closePool } = require("./helpers/db");
      const email = process.env.E2E_DUAL_EMAIL || "transpak.phase1.dual@example.com";
      const row = await findUserIdByEmail(email);
      const userId = row?.id;
      assert.ok(userId);

      await insertTestNotification(userId, "shipper", `ISO_S_${stamp}`, "shipper only");
      await insertTestNotification(userId, "carrier", `ISO_C_${stamp}`, "carrier only");

      const list = await api("GET", "/api/notifications", {
        token,
        workspace: "shipper",
        query: { limit: "50" }
      });
      assert.ok(list.ok, list.message);
      const items = list.payload?.items || [];
      const titles = items.map((n) => n.title);
      assert.ok(titles.includes(`ISO_S_${stamp}`));
      assert.ok(!titles.includes(`ISO_C_${stamp}`));

      const carrierList = await api("GET", "/api/notifications", {
        token,
        workspace: "carrier",
        query: { limit: "50" }
      });
      const carrierTitles = (carrierList.payload?.items || []).map((n) => n.title);
      assert.ok(carrierTitles.includes(`ISO_C_${stamp}`));
      assert.ok(!carrierTitles.includes(`ISO_S_${stamp}`));

      await closePool();
    });

    it("operations snapshot returns single role slice per workspace", async () => {
      const shipperSnap = await api("GET", "/api/operations/snapshot", {
        token,
        workspace: "shipper"
      });
      assert.equal(shipperSnap.status, 200);
      assert.ok(shipperSnap.payload?.shipper != null);
      assert.equal(shipperSnap.payload?.carrier, null);

      const carrierSnap = await api("GET", "/api/operations/snapshot", {
        token,
        workspace: "carrier"
      });
      assert.equal(carrierSnap.status, 200);
      assert.ok(carrierSnap.payload?.carrier != null);
      assert.equal(carrierSnap.payload?.shipper, null);
    });
  }
);

describe("Role isolation — HTTP snapshot (single-role)", {
  skip: integrationSuiteSkipReason()
}, () => {
  let shipper;
  let carrier;

  before(async () => {
    shipper = await login(
      process.env.E2E_SHIPPER_EMAIL,
      process.env.E2E_SHIPPER_PASSWORD,
      "shipper"
    );
    carrier = await login(
      process.env.E2E_CARRIER_EMAIL,
      process.env.E2E_CARRIER_PASSWORD,
      "carrier"
    );
  });

  it("shipper viewAs returns shipper slice only", async () => {
    const res = await api("GET", "/api/operations/snapshot?viewAs=shipper", {
      token: shipper.token
    });
    assert.equal(res.status, 200);
    const data = res.payload ?? res.data;
    assert.ok(data?.shipper != null);
    assert.equal(data?.carrier, null);
  });

  it("carrier viewAs returns carrier slice only", async () => {
    const res = await api("GET", "/api/operations/snapshot?viewAs=carrier", {
      token: carrier.token
    });
    assert.equal(res.status, 200);
    const data = res.payload ?? res.data;
    assert.ok(data?.carrier != null);
    assert.equal(data?.shipper, null);
  });
});

describe("normalizeWorkspace", () => {
  it("accepts commercial roles only", () => {
    assert.equal(normalizeWorkspace("Shipper"), "shipper");
    assert.equal(normalizeWorkspace("bogus"), null);
  });
});
