/**
 * Role isolation — snapshot scoped by viewAs / workspace.
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { integrationSuiteSkipReason } = require("./helpers/config");
const { api, login } = require("./helpers/http");

const feRoot = path.join(__dirname, "..", "..", "transpak-frontend", "src");

describe("Role isolation — static dashboard scoping", () => {
  it("ShipperDashboard does not read carrier ops slice", () => {
    const src = fs.readFileSync(path.join(feRoot, "pages", "dashboard", "ShipperDashboard.jsx"), "utf8");
    assert.ok(src.includes("ops?.shipper") || src.includes("ops.shipper"));
    assert.ok(!src.includes("ops?.carrier?.") && !src.includes("ops.carrier."));
  });

  it("CarrierDashboard does not read shipper ops slice", () => {
    const src = fs.readFileSync(path.join(feRoot, "pages", "dashboard", "CarrierDashboard.jsx"), "utf8");
    assert.ok(src.includes("ops?.carrier") || src.includes("ops.carrier"));
    assert.ok(!src.includes("ops?.shipper?.") && !src.includes("ops.shipper."));
  });
});

describe("Role isolation — HTTP snapshot", { skip: integrationSuiteSkipReason() }, () => {
  let shipper;
  let carrier;

  before(async () => {
    shipper = await login(
      process.env.E2E_SHIPPER_EMAIL,
      process.env.E2E_SHIPPER_PASSWORD,
      "shipper"
    );
    carrier = await login(
      process.env.E2E_CARRIER_EMAIL,
      process.env.E2E_CARRIER_PASSWORD,
      "carrier"
    );
  });

  it("shipper viewAs returns shipper slice only", async () => {
    const res = await api("GET", "/api/operations/snapshot?viewAs=shipper", {
      token: shipper.token
    });
    assert.equal(res.status, 200);
    const data = res.payload ?? res.data;
    assert.ok(data?.shipper != null);
    assert.equal(data?.carrier, null);
  });

  it("carrier viewAs returns carrier slice only", async () => {
    const res = await api("GET", "/api/operations/snapshot?viewAs=carrier", {
      token: carrier.token
    });
    assert.equal(res.status, 200);
    const data = res.payload ?? res.data;
    assert.ok(data?.carrier != null);
    assert.equal(data?.shipper, null);
  });
});
