/**
 * Phase 8 — Production stabilization static checks.
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

function readFe(rel) {
  return fs.readFileSync(path.join(frontendSrc, rel), "utf8");
}

describe("Phase 8 — ops telemetry & env", () => {
  it("opsTelemetry exports snapshot helpers", () => {
    const t = require("../utils/opsTelemetry");
    assert.equal(typeof t.getOpsSnapshot, "function");
    assert.equal(typeof t.recordHttpRequest, "function");
  });

  it("validateProductionEnv runs at server bootstrap", () => {
    const src = read("src/server.js");
    assert.ok(src.includes("validateProductionEnv"));
  });

  it("health endpoint exposes ops snapshot", () => {
    const src = read("src/app.js");
    assert.ok(src.includes("getOpsSnapshot"));
    assert.ok(src.includes("sockets"));
  });
});

describe("Phase 8 — socket hardening", () => {
  it("socket handlers rate-limit hot events", () => {
    const src = read("sockets/index.js");
    assert.ok(src.includes("allowSocketEvent"));
    assert.ok(src.includes('sock.leave(`user:${uid}:role:${other}`)'));
    assert.ok(src.includes("clearSocketRateLimits"));
  });

  it("frontend socket removes listeners on disconnect", () => {
    const src = readFe("services/socket.js");
    assert.ok(src.includes("socket.off"));
    assert.ok(src.includes("RECONNECT_REFRESH_MIN_MS"));
    assert.ok(src.includes("reconnectionAttempts"));
  });
});

describe("Phase 8 — cache & rate limits", () => {
  it("workspace cache prunes stale entries", () => {
    const src = readFe("utils/workspaceQueryCache.js");
    assert.ok(src.includes("pruneWorkspaceQueryCaches"));
    assert.ok(src.includes("MAX_ENTRIES"));
  });

  it("notifications route has dedicated limiter", () => {
    const src = read("routes/notificationRoutes.js");
    assert.ok(src.includes("notificationsRouteLimiter"));
  });

  it("global error handler hides stacks in production", () => {
    const src = read("utils/globalErrorHandler.js");
    assert.ok(src.includes("isProd"));
    assert.ok(src.includes("clientMessage"));
  });
});

describe("Phase 8 — deployment headers", () => {
  it("API responses set no-store cache control", () => {
    const src = read("middleware/deployHeaders.js");
    assert.ok(src.includes("no-store"));
  });

  it("helmet is enabled on express app", () => {
    const src = read("src/app.js");
    assert.ok(src.includes("helmet"));
  });

  it("CORS runs before API routes and allows required headers", () => {
    const src = read("src/app.js");
    const corsIdx = src.indexOf("app.use(cors(corsOptions))");
    const apiIdx = src.indexOf('app.use("/api", globalApiLimiter)');
    assert.ok(corsIdx >= 0 && apiIdx > corsIdx, "CORS middleware must run before /api rate limiter");
    assert.ok(src.includes("X-TransPak-Workspace"));
    assert.ok(src.includes("X-TransPak-User-Id"));
    assert.ok(src.includes(".pages.dev"));
    assert.ok(src.includes("optionsSuccessStatus"));
  });
});

describe("Phase 2 — BidList regression", () => {
  it("BidList imports isCounterOffered when sorting counter bids", () => {
    const src = readFe("components/loadboard/BidList.jsx");
    assert.ok(src.includes("isCounterOffered"), "BidList must import isCounterOffered");
    assert.ok(/import\s*\{[^}]*isCounterOffered[^}]*\}\s*from\s*['"].*bidStatus/.test(src));
    assert.ok(src.includes("isCounterOffered(bid.status)"));
  });
});

describe("Phase 2 — shipment timeline merge", () => {
  it("exports mergeShipmentTimelineEvents from optimistic status module", () => {
    const src = readFe("utils/shipmentStatusOptimistic.js");
    assert.ok(src.includes("export function mergeShipmentTimelineEvents"));
  });

  it("ActiveShipmentPanel and ShipmentTracking use shared merge helper", () => {
    const panel = readFe("components/dashboard/ActiveShipmentPanel.jsx");
    const tracking = readFe("pages/shipments/ShipmentTracking.jsx");
    assert.ok(panel.includes("mergeShipmentTimelineEvents"));
    assert.ok(tracking.includes("mergeShipmentTimelineEvents"));
    assert.ok(!panel.includes("if (historyEvents.length) return historyEvents"));
  });

  it("StatusTimeline dot colors use canonical status not translated labels", () => {
    const src = readFe("components/shipment/StatusTimeline.jsx");
    assert.ok(src.includes("timelineDotClassForStatus(e?.status || currentStatus)"));
    assert.ok(!src.includes("e?.label || currentStatus"));
  });

  it("carrier capacity browse is shipper-only on GET /carrier-space", () => {
    const src = read("routes/carrierSpaceRoutes.js");
    assert.ok(src.includes('requireAnyRole(["shipper", "admin"])'));
    assert.ok(!src.includes('requireAnyRole(["shipper", "carrier", "admin"])'));
  });

  it("reviews pending query exposes partner avatar field", () => {
    const src = read("routes/reviewRoutes.js");
    assert.ok(src.includes('"toUserAvatar"'));
  });

  it("reviews summary batch exposes lastReviewAt", () => {
    const src = read("routes/reviewRoutes.js");
    assert.ok(src.includes('router.get("/summary"'));
    assert.ok(src.includes('"lastReviewAt"'));
    assert.ok(src.includes("MAX(created_at)"));
  });

  it("list parents batch rating summaries at list level", () => {
    assert.ok(readFe("components/reviews/UserRatingBadge.jsx").includes("ratingMap"));
    assert.ok(!readFe("components/reviews/UserRatingBadge.jsx").includes("useReceivedRatingSummary"));
    assert.ok(readFe("hooks/useRatingSummaryBatch.js").includes("/reviews/summary"));
    assert.ok(readFe("components/loadboard/BidList.jsx").includes("useRatingSummaryBatch"));
  });

  it("tracking coordinator batches socket updates", () => {
    assert.ok(readFe("hooks/useTrackingCoordinator.js").includes("scheduleBufferedUpdate"));
    assert.ok(readFe("hooks/useShipmentTracking.js").includes("useTrackingCoordinator"));
  });
});
