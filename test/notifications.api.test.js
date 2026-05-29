/**
 * Phase 5 — Notification dedup + unread count stability (HTTP).
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { hasIntegrationEnv, skipIntegrationReason } = require("./helpers/config");
const { api, login } = require("./helpers/http");

describe("Notifications safety", { skip: hasIntegrationEnv() ? false : skipIntegrationReason() }, () => {
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
