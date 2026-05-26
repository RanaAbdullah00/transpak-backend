const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

function getBaseUrl() {
  const raw =
    process.env.QA_BASE_URL ||
    process.env.TEST_BASE_URL ||
    process.env.E2E_BASE_URL ||
    "http://127.0.0.1:10000";
  return String(raw).replace(/\/$/, "");
}

function hasDatabaseUrl() {
  return Boolean(String(process.env.DATABASE_URL || "").trim());
}

function hasHttpCredentials() {
  return Boolean(
    process.env.E2E_SHIPPER_EMAIL &&
      process.env.E2E_SHIPPER_PASSWORD &&
      process.env.E2E_CARRIER_EMAIL &&
      process.env.E2E_CARRIER_PASSWORD
  );
}

function hasAdminCredentials() {
  return Boolean(process.env.E2E_ADMIN_EMAIL && process.env.E2E_ADMIN_PASSWORD);
}

function hasSecondCarrier() {
  return Boolean(process.env.E2E_CARRIER2_EMAIL && process.env.E2E_CARRIER2_PASSWORD);
}

/** Full HTTP integration (live API + test accounts). */
function hasIntegrationEnv() {
  return hasHttpCredentials();
}

function skipIntegrationReason() {
  return "Set E2E_SHIPPER_EMAIL, E2E_SHIPPER_PASSWORD, E2E_CARRIER_EMAIL, E2E_CARRIER_PASSWORD and run API at QA_BASE_URL";
}

function skipDbReason() {
  return "Set DATABASE_URL for direct DB safety tests";
}

function skipConcurrencyReason() {
  if (!hasIntegrationEnv()) return skipIntegrationReason();
  if (!hasSecondCarrier()) {
    return "Set E2E_CARRIER2_EMAIL and E2E_CARRIER2_PASSWORD for dual-carrier concurrency test";
  }
  return false;
}

function skipAdminReason() {
  if (!hasIntegrationEnv()) return skipIntegrationReason();
  if (!hasAdminCredentials()) return "Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD for admin tests";
  return false;
}

module.exports = {
  getBaseUrl,
  hasDatabaseUrl,
  hasHttpCredentials,
  hasAdminCredentials,
  hasSecondCarrier,
  hasIntegrationEnv,
  skipIntegrationReason,
  skipDbReason,
  skipConcurrencyReason,
  skipAdminReason
};
