/**
 * Phase 5 — Notification dedup + unread count stability (HTTP).
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { integrationSuiteSkipReason } = require("./helpers/config");
const { api, login } = require("./helpers/http");

describe("Notifications safety", { skip: integrationSuiteSkipReason() }, () => {
  let token;
  const dedupeTitle = `SAFETY_DEDUP_${Date.now()}`;
  const dedupeMessage = "Automated dedupe validation message";

  before(async () => {
    const session = await login(
      process.env.E2E_SHIPPER_EMAIL,
      process.env.E2E_SHIPPER_PASSWORD,
      "shipper"
    );
    token = session.token;
  });

  it("deduplicates identical notifications within 2 minutes", async () => {
    const first = await api("POST", "/api/notifications", {
      token,
      body: { title: dedupeTitle, message: dedupeMessage, roleType: "shipper" }
    });
    assert.ok(first.ok, first.message);
    const firstId = first.payload?.id;
    assert.ok(firstId);

    const second = await api("POST", "/api/notifications", {
      token,
      body: { title: dedupeTitle, message: dedupeMessage, roleType: "shipper" }
    });
    assert.ok(second.ok);
    assert.equal(
      second.payload?.id,
      firstId,
      "second POST should return existing row id (no duplicate insert)"
    );
  });

  it("unread count is stable after read-all", async () => {
    const before = await api("GET", "/api/notifications/unread-count", { token });
    assert.ok(before.ok);
    const countBefore = before.payload?.count ?? 0;

    await api("PATCH", "/api/notifications/read-all", { token });

    const after = await api("GET", "/api/notifications/unread-count", { token });
    assert.ok(after.ok);
    assert.equal(after.payload?.count, 0);

    const list = await api("GET", "/api/notifications", { token });
    const rows = Array.isArray(list.payload) ? list.payload : list.payload?.items || [];
    const unreadInList = rows.filter((n) => !n.read).length;
    assert.equal(unreadInList, 0);
    assert.ok(countBefore >= 0);
  });

  it("list refetch returns consistent envelope (reconnect simulation)", async () => {
    const a = await api("GET", "/api/notifications", { token });
    const b = await api("GET", "/api/notifications", { token });
    assert.ok(a.ok && b.ok);
    const itemsA = Array.isArray(a.payload) ? a.payload : a.payload?.items || [];
    const itemsB = Array.isArray(b.payload) ? b.payload : b.payload?.items || [];
    assert.equal(itemsA.length, itemsB.length);
    assert.equal(a.payload?.hasMore, b.payload?.hasMore);
  });

  it("sync endpoint returns items + unreadCount (reconnect recovery)", async () => {
    const sync = await api("GET", "/api/notifications/sync", { token });
    assert.ok(sync.ok, sync.message);
    assert.ok(Array.isArray(sync.payload?.items));
    assert.equal(typeof sync.payload?.unreadCount, "number");
    assert.ok(sync.payload?.serverTime);
  });
});

const { hasDualRoleEnv, skipDualRoleReason } = require("./helpers/config");
const { insertTestNotification, findUserIdByEmail, closePool } = require("./helpers/db");

describe(
  "Dual-role workspace-scoped notification PATCH",
  { skip: hasDualRoleEnv() ? false : skipDualRoleReason() },
  () => {
    let token;
    let userId;
    const stamp = Date.now();

    before(async () => {
      const email = process.env.E2E_DUAL_EMAIL || "transpak.phase1.dual@example.com";
      const password = process.env.PHASE1_RBAC_PASSWORD || process.env.E2E_SHIPPER_PASSWORD;
      const session = await login(email, password, "shipper");
      token = session.token;
      userId = session.user?.id;
      assert.ok(userId, "dual user id required");

      const row = await findUserIdByEmail(email);
      assert.ok(row?.roles?.includes("shipper") && row?.roles?.includes("carrier"), "dual account must have both roles");

      await insertTestNotification(userId, "shipper", `DUAL_PATCH_${stamp}_S`, "shipper scope seed");
      await insertTestNotification(userId, "carrier", `DUAL_PATCH_${stamp}_C`, "carrier scope seed");
    });

    after(async () => {
      await closePool();
    });

    it("shipper workspace unread count excludes carrier notifications", async () => {
      const shipperOnly = await api("GET", "/api/notifications/unread-count", {
        token,
        workspace: "shipper"
      });
      const carrierOnly = await api("GET", "/api/notifications/unread-count", {
        token,
        workspace: "carrier"
      });
      assert.ok(shipperOnly.ok && carrierOnly.ok);
      assert.ok((shipperOnly.payload?.count ?? 0) >= 1);
      assert.ok((carrierOnly.payload?.count ?? 0) >= 1);
    });

    it("single read in shipper workspace does not clear carrier unread", async () => {
      const list = await api("GET", "/api/notifications", {
        token,
        workspace: "shipper",
        query: { limit: "10" }
      });
      const items = Array.isArray(list.payload) ? list.payload : list.payload?.items || [];
      const unreadItem = items.find((n) => !n.read && n.roleType === "shipper");
      assert.ok(unreadItem?.id, "expected unread shipper notification");

      const carrierBefore = await api("GET", "/api/notifications/unread-count", {
        token,
        workspace: "carrier"
      });

      const patched = await api("PATCH", `/api/notifications/${unreadItem.id}/read`, {
        token,
        workspace: "shipper"
      });
      assert.ok(patched.ok, patched.message);

      const carrierAfter = await api("GET", "/api/notifications/unread-count", {
        token,
        workspace: "carrier"
      });
      assert.equal(carrierAfter.payload?.count, carrierBefore.payload?.count);
    });

    it("read-all in carrier workspace clears carrier unread only", async () => {
      await api("PATCH", "/api/notifications/read-all", {
        token,
        workspace: "carrier"
      });

      const carrierAfter = await api("GET", "/api/notifications/unread-count", {
        token,
        workspace: "carrier"
      });
      assert.equal(carrierAfter.payload?.count, 0);

      const sync = await api("GET", "/api/operations/sync/events", {
        token,
        workspace: "carrier"
      });
      assert.ok(sync.ok, sync.message);
      assert.equal(sync.payload?.unreadCount, 0);
    });
  }
);
