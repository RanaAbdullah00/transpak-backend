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
    const bidRoutes = read("routes/bidRoutes.js");
    const bidRealtime = read("utils/bidRealtime.js");
    assert.ok(bidRoutes.includes("emitBidAcceptMarketplaceFanout"));
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
});
