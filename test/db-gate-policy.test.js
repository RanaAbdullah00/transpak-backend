/**
 * DB-not-ready gate — public auth and /public/* must bypass global 503 block.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { isDbGateExemptPath } = require("../utils/dbGatePolicy");

describe("dbGatePolicy — exempt paths", () => {
  it("allows health and policy-health", () => {
    assert.equal(isDbGateExemptPath("/health"), true);
    assert.equal(isDbGateExemptPath("/system/policy-health"), true);
  });

  it("allows public auth entry points", () => {
    assert.equal(isDbGateExemptPath("/auth/login"), true);
    assert.equal(isDbGateExemptPath("/auth/register"), true);
    assert.equal(isDbGateExemptPath("/auth/send-otp"), true);
    assert.equal(isDbGateExemptPath("/auth/verify-otp"), true);
    assert.equal(isDbGateExemptPath("/auth/resend-otp"), true);
    assert.equal(isDbGateExemptPath("/auth/otp/register/verify"), true);
    assert.equal(isDbGateExemptPath("/auth/otp/forgot/reset"), true);
  });

  it("allows public landing stats", () => {
    assert.equal(isDbGateExemptPath("/public/stats"), true);
  });

  it("blocks protected auth and commercial routes", () => {
    assert.equal(isDbGateExemptPath("/auth/profile"), false);
    assert.equal(isDbGateExemptPath("/auth/active-role"), false);
    assert.equal(isDbGateExemptPath("/auth/add-role"), false);
    assert.equal(isDbGateExemptPath("/loads"), false);
    assert.equal(isDbGateExemptPath("/shipments/active"), false);
    assert.equal(isDbGateExemptPath("/admin/dashboard/live"), false);
  });
});
