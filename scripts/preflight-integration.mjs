#!/usr/bin/env node
/**
 * Probe integration API health and set INTEGRATION_SERVER_READY for test runner.
 * Exit 0 always — tests skip HTTP suites when server is down (no cascade failures).
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { getBaseUrl, hasIntegrationEnv } = require("../test/helpers/config");
const { isServerReachable } = require("../test/helpers/serverReachable");

async function main() {
  if (!hasIntegrationEnv()) {
    process.env.INTEGRATION_SERVER_READY = "0";
    console.log("[preflight-integration] No E2E credentials — HTTP suites will skip.");
    return;
  }
  const base = getBaseUrl();
  const ok = await isServerReachable(base);
  process.env.INTEGRATION_SERVER_READY = ok ? "1" : "0";
  if (ok) {
    console.log(`[preflight-integration] OK — ${base}/api/health`);
  } else {
    console.warn(
      `[preflight-integration] SKIP HTTP suites — unreachable ${base}. Start: cd transpak-backend && npm start`
    );
  }
}

main().catch((err) => {
  console.warn("[preflight-integration] probe failed:", err.message);
  process.env.INTEGRATION_SERVER_READY = "0";
});
