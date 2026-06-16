/**
 * Phase 7 — Static security / realtime / concurrency guards (no HTTP).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const frontendSrc = path.join(__dirname, "..", "..", "transpak-frontend", "src");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function readFrontend(rel) {
  return fs.readFileSync(path.join(frontendSrc, rel), "utf8");
}

describe("Phase 7 — RBAC & IDOR static guards", () => {
  it("bid accept uses row-level FOR UPDATE", () => {
    const src = read("utils/bidAcceptance.js");
    assert.ok(src.includes("FOR UPDATE OF l, b"));
  });

  it("bid insert uses ON CONFLICT for carrier+load uniqueness", () => {
    const bidRoutes = read("routes/bidRoutes.js");
    assert.ok(bidRoutes.includes("ON CONFLICT (load_id, carrier_id)"));
  });

  it("bookings and shipments use ON CONFLICT on load_id", () => {
    const src = read("utils/bidAcceptance.js");
    assert.ok(src.includes("ON CONFLICT (load_id)"));
  });

  it("notifications use dedupe_key unique constraint handling", () => {
    const src = read("utils/notifyEvent.js");
    const guard = read("db/schemaGuard.js");
    assert.ok(src.includes("ON CONFLICT ON CONSTRAINT uq_notifications_receiver_dedupe_full"));
    assert.ok(src.includes("findByDedupeKey"));
    assert.ok(guard.includes("verifyNotificationDedupeConstraint"));
    assert.ok(guard.includes("uq_notifications_receiver_dedupe_full"));
  });

  it("notification routes resolve workspace header", () => {
    const src = read("routes/notificationRoutes.js");
    assert.ok(src.includes("resolveNotificationWorkspace"));
    assert.ok(src.includes("/sync"));
  });

  it("fleet matching uses approved trucks only", () => {
    const src = read("utils/loadMatching.js");
    assert.ok(src.includes("approved"));
  });
});

describe("Phase 7 — frontend session / realtime isolation", () => {
  it("realtimeDedupe caps seen event ids", () => {
    const src = readFrontend("utils/realtimeDedupe.js");
    assert.ok(src.includes("SEEN_MAX"));
    assert.ok(src.includes("shouldProcessRealtimeEvent"));
  });

  it("session cleanup utility exists for logout races", () => {
    const src = readFrontend("utils/sessionCleanup.js");
    assert.ok(src.includes("clearEntireSession"));
    assert.ok(src.includes("prepareWorkspaceSwitch"));
  });

  it("AppContext listens for unread-sync reconciliation", () => {
    const src = readFrontend("context/AppContext.jsx");
    assert.ok(src.includes("tp:unread-sync") || src.includes("unread-sync"));
  });

  it("socket service supports workspace join", () => {
    const src = readFrontend("services/socket.js");
    assert.ok(src.includes("workspace") || src.includes("join"));
  });
});

describe("Phase 7 — attack surface body guards", () => {
  it("global rejectForbiddenBodyFields remains mounted", () => {
    const src = read("src/app.js");
    assert.ok(src.includes("rejectForbiddenBodyFields"));
  });
});
