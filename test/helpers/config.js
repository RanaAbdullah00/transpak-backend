const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");

require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const PORT_FILE = path.join(REPO_ROOT, ".dev-backend-port");

function readPortFile() {
  try {
    if (!fs.existsSync(PORT_FILE)) return null;
    const n = Number(String(fs.readFileSync(PORT_FILE, "utf8")).trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function discoverViaScript() {
  try {
    const script = path.join(REPO_ROOT, "scripts", "discover-backend-port.mjs");
    const out = execSync(`node "${script}"`, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

const PRODUCTION_API = "https://transpak-backend-1.onrender.com";

/** Resolve Phase-1 / gate-style E2E accounts (ONLY_EMAIL aliases + shared password). */
function getE2ECredentials() {
  const sharedPassword =
    process.env.PHASE1_RBAC_PASSWORD ||
    process.env.E2E_SHIPPER_PASSWORD ||
    process.env.E2E_CARRIER_PASSWORD ||
    "";
  return {
    shipperEmail: process.env.E2E_SHIPPER_EMAIL || process.env.E2E_SHIPPER_ONLY_EMAIL || "",
    shipperPassword: process.env.E2E_SHIPPER_PASSWORD || sharedPassword,
    carrierEmail: process.env.E2E_CARRIER_EMAIL || process.env.E2E_CARRIER_ONLY_EMAIL || "",
    carrierPassword: process.env.E2E_CARRIER_PASSWORD || sharedPassword,
    carrier2Email: process.env.E2E_CARRIER2_EMAIL || "",
    carrier2Password: process.env.E2E_CARRIER2_PASSWORD || sharedPassword,
    adminEmail: process.env.E2E_ADMIN_EMAIL || process.env.E2E_ADMIN_ONLY_EMAIL || "",
    adminPassword: process.env.E2E_ADMIN_PASSWORD || sharedPassword
  };
}

function hasPhase1ProductionEnv() {
  const c = getE2ECredentials();
  return Boolean(c.shipperEmail && c.shipperPassword && c.carrierEmail && c.carrierPassword);
}

function getBaseUrl() {
  const raw =
    process.env.QA_BASE_URL ||
    process.env.TEST_BASE_URL ||
    process.env.E2E_BASE_URL ||
    process.env.VITE_API_URL ||
    "";
  if (raw) return String(raw).replace(/\/$/, "");

  if (hasPhase1ProductionEnv()) {
    return PRODUCTION_API;
  }

  const fromFile = readPortFile();
  if (fromFile) {
    return `http://127.0.0.1:${fromFile}`;
  }

  const discovered = discoverViaScript();
  if (discovered) return discovered.replace(/\/$/, "");

  const fallbackPort = Number(process.env.PORT || 10000);
  return `http://127.0.0.1:${fallbackPort}`;
}

function hasDatabaseUrl() {
  return Boolean(String(process.env.DATABASE_URL || "").trim());
}

function hasHttpCredentials() {
  return hasPhase1ProductionEnv();
}

function hasAdminCredentials() {
  const c = getE2ECredentials();
  return Boolean(c.adminEmail && c.adminPassword);
}

function hasSecondCarrier() {
  return Boolean(process.env.E2E_CARRIER2_EMAIL && process.env.E2E_CARRIER2_PASSWORD);
}

/** Full HTTP integration (live API + test accounts). */
function hasIntegrationEnv() {
  return hasHttpCredentials();
}

function skipIntegrationReason() {
  return "Set PHASE1_RBAC_PASSWORD plus E2E_SHIPPER_ONLY_EMAIL and E2E_CARRIER_ONLY_EMAIL (or standard E2E_* pairs) and QA_BASE_URL or use production Phase-1 accounts";
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

/** Dual-role notification PATCH — needs DB seed + reachable API + RBAC password. */
function hasDualRoleEnv() {
  const password = process.env.PHASE1_RBAC_PASSWORD || process.env.E2E_SHIPPER_PASSWORD;
  const email = process.env.E2E_DUAL_EMAIL || "transpak.phase1.dual@example.com";
  if (!hasDatabaseUrl() || !password || !email) return false;
  const apiExplicit = Boolean(
    process.env.QA_BASE_URL ||
      process.env.TEST_BASE_URL ||
      process.env.E2E_BASE_URL ||
      process.env.VITE_API_URL
  );
  return apiExplicit || hasPhase1ProductionEnv();
}

function skipDualRoleReason() {
  if (!hasDatabaseUrl()) return skipDbReason();
  const password = process.env.PHASE1_RBAC_PASSWORD || process.env.E2E_SHIPPER_PASSWORD;
  if (!password) return "Set PHASE1_RBAC_PASSWORD or E2E_SHIPPER_PASSWORD for dual-role notification tests";
  if (!hasDualRoleEnv()) {
    return "Set VITE_API_URL or QA_BASE_URL (reachable API) for dual-role notification HTTP tests";
  }
  return false;
}

module.exports = {
  getBaseUrl,
  getE2ECredentials,
  hasDatabaseUrl,
  hasHttpCredentials,
  hasAdminCredentials,
  hasSecondCarrier,
  hasPhase1ProductionEnv,
  hasIntegrationEnv,
  skipIntegrationReason,
  skipDbReason,
  skipConcurrencyReason,
  skipAdminReason,
  hasDualRoleEnv,
  skipDualRoleReason
};