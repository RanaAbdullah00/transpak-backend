/**
 * Admin notifications — persistence and dedupe static gates.
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

describe("Admin notifications integration", () => {
  it("alertEngine persists via notifyAdmins", () => {
    const src = read("utils/alertEngine.js");
    assert.ok(src.includes("notifyAdmins"));
    assert.ok(src.includes("system_alerts"));
  });

  it("adminNotify uses dedupe_key path", () => {
    const src = read("utils/adminNotify.js");
    assert.ok(src.includes("idempotencyKey") || src.includes("dedupe"));
  });

  it("AdminNotifications uses admin mark-read routes", () => {
    const src = fs.readFileSync(path.join(feRoot, "pages", "admin", "AdminNotifications.jsx"), "utf8");
    assert.ok(src.includes("/admin/notifications/"));
    assert.ok(src.includes("read-all"));
  });
});
