/**
 * Admin audit API — static + optional HTTP IDOR gates.
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { hasIntegrationEnv, skipIntegrationReason, hasAdminCredentials } = require("./helpers/config");
const { api, login } = require("./helpers/http");

const root = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

describe("Admin audit API — static", () => {
  it("audit-events and activity-feed behind admin session guard", () => {
    const src = read("routes/adminRoutes.js");
    const guardIdx = src.indexOf("router.use(protect, requireAdminSession");
    const auditIdx = src.indexOf('"/audit-events"');
    const feedIdx = src.indexOf('"/activity-feed"');
    assert.ok(guardIdx >= 0);
    assert.ok(auditIdx > guardIdx);
    assert.ok(feedIdx > guardIdx);
  });

  it("admin notification mark-read routes exist", () => {
    const src = read("routes/adminRoutes.js");
    assert.ok(src.includes('"/notifications/:id/read"'));
    assert.ok(src.includes('"/notifications/read-all"'));
  });

  it("audit-events uses parameterized filters", () => {
    const src = read("routes/adminRoutes.js");
    assert.ok(src.includes("audit_events"));
    assert.ok(!src.includes("${req.query"));
  });
});

describe("Admin audit API — HTTP", { skip: hasIntegrationEnv() ? false : skipIntegrationReason() }, () => {
  let shipper;
  let admin;

  before(async () => {
    shipper = await login(
      process.env.E2E_SHIPPER_EMAIL,
      process.env.E2E_SHIPPER_PASSWORD,
      "shipper"
    );
    if (hasAdminCredentials()) {
      admin = await login(
        process.env.E2E_ADMIN_EMAIL,
        process.env.E2E_ADMIN_PASSWORD,
        "admin"
      );
    }
  });

  it("non-admin cannot access audit-events", async () => {
    const res = await api("GET", "/api/admin/audit-events?page=1&limit=5", {
      token: shipper.token
    });
    assert.ok(res.status === 403 || res.status === 401, `expected 401/403 got ${res.status}`);
  });

  it("non-admin cannot access activity-feed", async () => {
    const res = await api("GET", "/api/admin/activity-feed?page=1&limit=5", {
      token: shipper.token
    });
    assert.ok(res.status === 403 || res.status === 401, `expected 401/403 got ${res.status}`);
  });

  it("admin can access audit-events when credentials provided", async () => {
    if (!admin) return;
    const res = await api("GET", "/api/admin/audit-events?page=1&limit=5", {
      token: admin.token
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body?.data?.rows) || Array.isArray(res.body?.data));
  });
});
