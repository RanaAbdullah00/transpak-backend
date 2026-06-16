/**
 * Admin dashboard stabilization — static wiring gates.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const feRoot = path.join(root, "..", "transpak-frontend", "src");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function readFe(rel) {
  return fs.readFileSync(path.join(feRoot, rel), "utf8");
}

describe("admin dashboard static gates", () => {
  it("backend cache layer and handler omit expiry hot-path", () => {
    assert.ok(fs.existsSync(path.join(root, "utils/adminDashboardCache.js")));
    const handler = read("utils/adminDashboardHandler.js");
    assert.ok(!handler.includes("runMarketplaceExpiryProcessor"));
    assert.ok(handler.includes("adminDashboardCache"));
    assert.ok(handler.includes("durationMs"));
  });

  it("cache invalidation wired on bid accept, shipment status, fleet approve", () => {
    assert.ok(read("utils/bidAcceptance.js").includes("invalidateAdminDashboardCache"));
    assert.ok(read("routes/shipmentRoutes.js").includes("invalidateAdminDashboardCache"));
    assert.ok(read("src/controllers/adminFleetController.js").includes("invalidateAdminDashboardCache"));
  });

  it("widget routes log slow fetches", () => {
    assert.ok(read("routes/adminDashboardWidgetRoutes.js").includes("ADMIN_TELEMETRY_SLOW_MS"));
  });

  it("frontend admin live feed components and hooks exist", () => {
    assert.ok(fs.existsSync(path.join(feRoot, "hooks/useAdminLiveFeed.js")));
    assert.ok(fs.existsSync(path.join(feRoot, "components/admin/AdminActivityCard.jsx")));
    assert.ok(fs.existsSync(path.join(feRoot, "components/admin/AdminLiveFeedPanel.jsx")));
    const page = readFe("pages/admin/AdminDashboardPage.jsx");
    assert.ok(page.includes("useAdminLiveFeed"));
    assert.ok(page.includes("AdminLiveFeedPanel"));
    assert.ok(page.includes("connectionState"));
  });

  it("frontend admin API uses staggered batches and widget dedup", () => {
    const api = readFe("utils/adminDashboardApi.js");
    assert.ok(api.includes("WIDGET_BATCHES"));
    assert.ok(api.includes("widgetInflight"));
    assert.ok(api.includes("isNetworkError"));
  });
});
