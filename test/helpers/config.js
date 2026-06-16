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

function getBaseUrl() {
  const raw =
    process.env.QA_BASE_URL ||
    process.env.TEST_BASE_URL ||
    process.env.E2E_BASE_URL ||
    process.env.VITE_API_URL ||
    "";
  if (raw) return String(raw).replace(/\/$/, "");

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
  return apiExplicit || hasHttpCredentials();
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
  hasDatabaseUrl,
  hasHttpCredentials,
  hasAdminCredentials,
  hasSecondCarrier,
  hasIntegrationEnv,
  skipIntegrationReason,
  skipDbReason,
  skipConcurrencyReason,
  skipAdminReason,
  hasDualRoleEnv,
  skipDualRoleReason
};