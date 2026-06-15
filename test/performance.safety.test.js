/**
 * Phase 6 — Lightweight performance / safety checks.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { hasIntegrationEnv, skipIntegrationReason, hasAdminCredentials, skipAdminReason } = require("./helpers/config");
const { api, login, healthCheck } = require("./helpers/http");

const FRONTEND_SRC = path.join(__dirname, "..", "..", "transpak-frontend", "src");

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

describe("Performance safety (HTTP timing)", { skip: hasIntegrationEnv() ? false : skipIntegrationReason() }, () => {
  const MAX_MS = Number(process.env.TEST_API_MAX_MS || 12000);

  it("health responds within budget", async () => {
    const t0 = Date.now();
    const res = await healthCheck();
    const ms = Date.now() - t0;
    assert.ok(res.ok || res.status === 200);
    assert.ok(ms < MAX_MS, `health took ${ms}ms`);
  });

  it("carrier load list responds within budget", async () => {
    const carrier = await login(
      process.env.E2E_CARRIER_EMAIL,
      process.env.E2E_CARRIER_PASSWORD,
      "carrier"
    );
    const t0 = Date.now();
    const res = await api("GET", "/api/loads/", { token: carrier.token });
    const ms = Date.now() - t0;
    assert.ok(res.ok, res.message);
    assert.ok(ms < MAX_MS, `GET /api/loads took ${ms}ms`);
    const list = Array.isArray(res.payload) ? res.payload : res.payload?.items ?? [];
    assert.ok(Array.isArray(list));
  });
});

describe("Admin dashboard timing", { skip: skipAdminReason() }, () => {
  const MAX_MS = Number(process.env.TEST_ADMIN_MAX_MS || 15000);
  const WARM_MAX_MS = Number(process.env.TEST_ADMIN_WARM_MAX_MS || 10000);

  it("GET /admin/dashboard/live within budget", async () => {
    const admin = await login(process.env.E2E_ADMIN_EMAIL, process.env.E2E_ADMIN_PASSWORD, "admin");
    const t0 = Date.now();
    const res = await api("GET", "/api/admin/dashboard/live", { token: admin.token });
    const ms = Date.now() - t0;
    assert.ok(res.ok, res.message);
    assert.ok(ms < MAX_MS, `admin live dashboard took ${ms}ms`);
    assert.ok(res.payload?.stats);
  });

  it("GET /admin/dashboard/live warm response within budget", async () => {
    const admin = await login(process.env.E2E_ADMIN_EMAIL, process.env.E2E_ADMIN_PASSWORD, "admin");
    await api("GET", "/api/admin/dashboard/live", { token: admin.token });
    const t0 = Date.now();
    const res = await api("GET", "/api/admin/dashboard/live", { token: admin.token });
    const ms = Date.now() - t0;
    assert.ok(res.ok, res.message);
    assert.ok(ms < WARM_MAX_MS, `admin live dashboard warm took ${ms}ms`);
  });

  it("GET /admin/dashboard/widgets/loads within budget", async () => {
    const admin = await login(process.env.E2E_ADMIN_EMAIL, process.env.E2E_ADMIN_PASSWORD, "admin");
    const t0 = Date.now();
    const res = await api("GET", "/api/admin/dashboard/widgets/loads", { token: admin.token });
    const ms = Date.now() - t0;
    assert.ok(res.ok, res.message);
    assert.ok(ms < WARM_MAX_MS, `admin loads widget took ${ms}ms`);
    assert.equal(res.payload?.widget, "loads");
  });
});

describe("Frontend polling safety (static)", () => {
  it("AppContext refetches notifications on socket reconnect (no orphan poll)", () => {
    const src = readIfExists(path.join(FRONTEND_SRC, "context", "AppContext.jsx"));
    if (!src) return;
    assert.ok(
      src.includes("onReconnect: refetchNotifications") || src.includes("onReconnect"),
      "socket reconnect should trigger notification refetch"
    );
    assert.ok(src.includes("client.disconnect()"), "socket should disconnect on unmount");
  });

  it("useSafeInterval hook exists for admin dashboard polling", () => {
    const hookPath = path.join(FRONTEND_SRC, "hooks", "useSafeInterval.js");
    assert.ok(fs.existsSync(hookPath), "useSafeInterval.js should exist");
  });
});
