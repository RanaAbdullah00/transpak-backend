const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { validateNotificationRole } = require("../utils/roleNotifyGuard");

describe("roleNotifyGuard", () => {
  it("allows null roleType (legacy)", async () => {
    const r = await validateNotificationRole("00000000-0000-4000-8000-000000000001", null);
    assert.equal(r.ok, true);
  });

  it("rejects unknown role without throwing", async () => {
    const r = await validateNotificationRole("00000000-0000-4000-8000-000000000001", "guest");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "unknown_role");
  });

  it("rejects missing receiver without throwing", async () => {
    const r = await validateNotificationRole("", "shipper");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "missing_receiver");
  });
});
