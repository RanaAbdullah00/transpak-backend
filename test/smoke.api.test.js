/**
 * Phase 1 — HTTP smoke against a running TransPak API.
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const {
  integrationSuiteSkipReason,
  hasAdminCredentials,
  skipAdminReason
} = require("./helpers/config");
const {
  api,
  login,
  createOpenLoad,
  placeBid,
  acceptBid,
  healthCheck
} = require("./helpers/http");

const shipperEmail = () => process.env.E2E_SHIPPER_EMAIL;
const shipperPass = () => process.env.E2E_SHIPPER_PASSWORD;
const carrierEmail = () => process.env.E2E_CARRIER_EMAIL;
const carrierPass = () => process.env.E2E_CARRIER_PASSWORD;
const adminEmail = () => process.env.E2E_ADMIN_EMAIL;
const adminPass = () => process.env.E2E_ADMIN_PASSWORD;

describe("API smoke", { skip: integrationSuiteSkipReason() }, () => {
  /** @type {{ token: string, user: object }} */
  let shipper;
  /** @type {{ token: string, user: object }} */
  let carrier;
  /** @type {{ id: string, code?: string }} */
  let load;
  /** @type {{ id: string }} */
  let bid;

  before(async () => {
    const health = await healthCheck();
    assert.equal(health.data?.success, true, "API health should return success envelope");
    shipper = await login(shipperEmail(), shipperPass(), "shipper");
    carrier = await login(carrierEmail(), carrierPass(), "carrier");
  });

  it("auth login returns token and user", () => {
    assert.ok(shipper.token);
    assert.ok(shipper.user?.id || shipper.user?.email);
  });

  it("GET /api/profile returns profile envelope", async () => {
    const res = await api("GET", "/api/profile", { token: shipper.token });
    assert.ok(res.ok, res.message);
    assert.equal(res.data?.success, true);
  });

  it("POST /api/loads/create creates open load", async () => {
    load = await createOpenLoad(shipper.token);
    assert.ok(load.id);
    const st = String(load.status || "").toLowerCase();
    assert.equal(st, "open", `unexpected load status: ${load.status}`);
    assert.equal(load.flowStatus, "POSTED");
  });

  it("POST /api/bids places carrier bid", async () => {
    assert.ok(load?.id);
    bid = await placeBid(carrier.token, load.id, 145000);
    assert.ok(bid.id);
  });

  it("PUT /api/bids/:id/accept books load and creates shipment", async () => {
    assert.ok(bid?.id);
    const accepted = await acceptBid(shipper.token, bid.id);
    assert.ok(accepted.ok, accepted.message);
    assert.equal(accepted.data?.success, true);

    const track = await api("GET", `/api/shipments/track/${encodeURIComponent(load.code)}`, {
      token: shipper.token
    });
    assert.ok(track.ok || track.status === 200, track.message);
  });

  it("GET /api/notifications lists for shipper", async () => {
    const res = await api("GET", "/api/notifications", { token: shipper.token });
    assert.ok(res.ok);
    assert.equal(res.data?.success, true);
    assert.ok(Array.isArray(res.payload) || Array.isArray(res.payload?.items));
  });

  it("GET /api/notifications/unread-count returns number", async () => {
    const res = await api("GET", "/api/notifications/unread-count", { token: shipper.token });
    assert.ok(res.ok);
    assert.equal(typeof res.payload?.count, "number");
  });

  it("GET /api/demo-video/info is public", async () => {
    const res = await api("GET", "/api/demo-video/info");
    assert.equal(res.data?.success, true);
    assert.ok("hasVideo" in (res.payload || {}));
  });

  it("GET /api/disputes/mine returns array envelope", async () => {
    const res = await api("GET", "/api/disputes/mine", { token: shipper.token });
    assert.ok(res.ok);
    assert.ok(Array.isArray(res.payload));
  });
});

describe("Admin API smoke", { skip: skipAdminReason() }, () => {
  /** @type {{ token: string }} */
  let admin;

  before(async () => {
    admin = await login(adminEmail(), adminPass(), "admin");
  });

  it("GET /api/admin/stats", async () => {
    const res = await api("GET", "/api/admin/stats", { token: admin.token });
    assert.ok(res.ok, res.message);
    assert.equal(res.data?.success, true);
    assert.ok(res.payload);
  });

  it("GET /api/admin/dashboard/live includes observability", async () => {
    const res = await api("GET", "/api/admin/dashboard/live", { token: admin.token });
    assert.ok(res.ok, res.message);
    assert.ok(res.payload?.stats);
    assert.ok(res.payload?.observability);
    assert.ok(Array.isArray(res.payload?.auditEvents));
  });

  it("GET /api/admin/disputes", async () => {
    const res = await api("GET", "/api/admin/disputes", { token: admin.token });
    assert.ok(res.ok);
    assert.ok(Array.isArray(res.payload));
  });

  it("carrier cannot access admin stats", async () => {
    const carrier = await login(carrierEmail(), carrierPass(), "carrier");
    const res = await api("GET", "/api/admin/stats", { token: carrier.token });
    assert.equal(res.status, 403);
    assert.equal(res.data?.success, false);
    assert.ok(res.code);
  });
});
