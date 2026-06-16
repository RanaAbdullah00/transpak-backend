/**
 * Production stabilization — static regression gates (P0–P3).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

describe("production stabilization static gates", () => {
  it("bid accept fans out marketplace refresh to losing carriers", () => {
    const bidAcceptance = read("utils/bidAcceptance.js");
    const bidRealtime = read("utils/bidRealtime.js");
    assert.ok(bidAcceptance.includes("emitBidAcceptMarketplaceFanout"));
    assert.ok(bidRealtime.includes("BID_REJECTED"));
    assert.ok(bidRealtime.includes("LOAD_ACCEPTED"));
  });

  it("validateBidPlacement rejects accepted loads", () => {
    const src = read("utils/matchingEngine.js");
    assert.ok(src.includes("accepted_bid_id"));
    assert.ok(src.includes("BID_ALREADY_ACCEPTED"));
  });

  it("write paths use non-blocking notifyUser on reviews and carrier-space", () => {
    const review = read("routes/reviewRoutes.js");
    assert.ok(review.includes("void notifyUser({"));
    assert.ok(!review.includes("await notifyUser({\n      receiverId: toUserId"));
    const space = read("routes/carrierSpaceRoutes.js");
    assert.ok(space.includes("void notifyUser({"));
    const booking = read("routes/spaceBookingRoutes.js");
    assert.match(booking, /void notifyUser\(\{/);
  });

  it("GET /shipments/history alias exists", () => {
    assert.ok(read("routes/shipmentRoutes.js").includes('"/history"'));
  });

  it("load and capacity POST use idempotency middleware", () => {
    assert.ok(read("routes/loadRoutes.js").includes('withIdempotencyKey("load_post")'));
    assert.ok(read("routes/carrierSpaceRoutes.js").includes('withIdempotencyKey("capacity_post")'));
    assert.ok(read("routes/spaceBookingRoutes.js").includes('withIdempotencyKey("capacity_request")'));
  });

  it("tracking payload includes carrier and vehicle fields", () => {
    const src = read("utils/trackingPayload.js");
    assert.ok(src.includes("carrier_name"));
    assert.ok(src.includes("truck_plate"));
    assert.ok(src.includes("driverName"));
  });

  it("timeline dedupe helper is wired", () => {
    const src = read("../transpak-frontend/src/utils/shipmentStatusOptimistic.js");
    assert.ok(src.includes("dedupeTimelineEvents"));
    assert.ok(src.includes("dedupeTimelineEvents("));
  });

  it("approved trucks cannot be deleted by carriers", () => {
    assert.ok(read("src/controllers/truckController.js").includes("TRUCK_APPROVED_LOCKED"));
  });

  it("review dismiss API and migration exist", () => {
    const review = read("routes/reviewRoutes.js");
    assert.ok(review.includes('"/dismiss"'));
    assert.ok(review.includes('"/dismissed"'));
    assert.ok(review.includes("review_prompt_dismissed"));
    assert.ok(fs.existsSync(path.join(root, "db/migrations/029_review_prompt_dismissed.sql")));
  });

  it("space request does not rewind active contracts", () => {
    const src = read("routes/spaceBookingRoutes.js");
    assert.ok(src.includes("SPACE_REQUEST_LOCKED"));
    assert.ok(!src.includes("ON CONFLICT (listing_id, shipper_id)"));
  });

  it("capacity DELETE blocked when listing has active agreements", () => {
    const src = read("routes/carrierSpaceRoutes.js");
    assert.ok(src.includes("router.delete("));
    assert.ok(src.includes("cannot be deleted"));
    assert.ok(src.includes("LISTING_ACTIVE"));
  });

  it("frontend wires filterOpenLoads and load-booked events", () => {
    const avail = read("../transpak-frontend/src/pages/loads/AvailableLoads.jsx");
    assert.ok(avail.includes("filterOpenLoads"));
    assert.ok(avail.includes("tp:load-booked"));
    const pipeline = read("../transpak-frontend/src/utils/notificationPipeline.js");
    assert.ok(pipeline.includes("tp:load-booked"));
  });

  it("tracking socket imports session manager helpers", () => {
    const src = read("../transpak-frontend/src/hooks/useTrackingSocket.js");
    assert.ok(src.includes("joinSession"));
    assert.ok(src.includes("trackingSessionManager"));
  });

  it("bid POST uses idempotency and acceptListedFare auto-book path", () => {
    const bidRoutes = read("routes/bidRoutes.js");
    assert.ok(bidRoutes.includes('withIdempotencyKey("bid_post")'));
    assert.ok(bidRoutes.includes("acceptListedFare"));
    assert.ok(bidRoutes.includes("acceptBidAndBook"));
  });

  it("capacity expiry runs in marketplace scheduler", () => {
    const src = read("utils/loadExpiry.js");
    assert.ok(src.includes("closeExpiredCapacityListings"));
  });

  it("admin audit and activity feed endpoints exist", () => {
    const admin = read("routes/adminRoutes.js");
    assert.ok(admin.includes("/audit-events"));
    assert.ok(admin.includes("/activity-feed"));
  });

  it("performance index migration registered", () => {
    const migrate = read("db/migrate.js");
    assert.ok(migrate.includes("030_performance_indexes.sql"));
    assert.ok(fs.existsSync(path.join(root, "db/migrations/030_performance_indexes.sql")));
  });

  it("MyBids filters expired bids", () => {
    const src = read("../transpak-frontend/src/pages/bids/MyBids.jsx");
    assert.ok(src.includes("isBidExpired"));
    assert.ok(src.includes("isActiveBidStatus"));
  });

  it("mark notification read persists via API", () => {
    const src = read("../transpak-frontend/src/context/AppContext.jsx");
    assert.ok(src.includes("api.patch(`/notifications/${id}/read`"));
  });

  it("realtime dedupe utilities are wired on ingress paths", () => {
    const backend = read("utils/socketEventDedupe.js");
    const frontend = read("../transpak-frontend/src/utils/eventDedupeCache.js");
    const appCtx = read("../transpak-frontend/src/context/AppContext.jsx");
    assert.ok(backend.includes("claimDistributedEvent"));
    assert.ok(frontend.includes("createEventDedupeCache"));
    assert.ok(appCtx.includes("trackingEventDedupeCache") || appCtx.includes("eventDedupeCache"));
  });

  it("useShipmentTracking composes useTrackingSocket without duplicate emit", () => {
    const src = read("../transpak-frontend/src/hooks/useShipmentTracking.js");
    assert.ok(src.includes("useTrackingSocket"));
    assert.ok(!src.includes("emitTrackingJoin(activeSocket"));
  });

  it("load post converts tons to kg", () => {
    const src = read("../transpak-frontend/src/pages/loads/PostLoad.jsx");
    assert.ok(src.includes("tonsToKg"));
  });

  it("BID_AUTO_ACCEPT_LISTED_FARE env gate in bid routes", () => {
    const src = read("routes/bidRoutes.js");
    assert.ok(src.includes("BID_AUTO_ACCEPT_LISTED_FARE"));
    assert.ok(src.includes("acceptListedFare"));
  });
});
