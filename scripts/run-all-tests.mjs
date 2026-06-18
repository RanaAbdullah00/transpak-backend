#!/usr/bin/env node
/**
 * Run backend tests with integration preflight (sets INTEGRATION_SERVER_READY).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");
const require = createRequire(path.join(backendRoot, "package.json"));

require("dotenv").config({ path: path.join(backendRoot, ".env") });

const { getBaseUrl, hasIntegrationEnv } = require(path.join(backendRoot, "test/helpers/config.js"));
const { isServerReachable } = require(path.join(backendRoot, "test/helpers/serverReachable.js"));

async function main() {
  const testEnv = { ...process.env };

  if (!hasIntegrationEnv()) {
    testEnv.INTEGRATION_SERVER_READY = "0";
    console.log("[run-all-tests] No E2E credentials — HTTP suites will skip.");
  } else {
    const base = getBaseUrl();
    const ok = await isServerReachable(base);
    testEnv.INTEGRATION_SERVER_READY = ok ? "1" : "0";
    if (ok) {
      console.log(`[run-all-tests] Integration API OK — ${base}`);
      testEnv.DISABLE_LOGIN_RATE_LIMIT = "1";
    } else {
      console.warn(`[run-all-tests] Integration API down — ${base} (HTTP suites skip)`);
    }
  }

  const result = spawnSync(process.execPath, ["--test", "test/*.test.js"], {
    cwd: backendRoot,
    stdio: "inherit",
    env: testEnv
  });

  process.exit(result.status ?? 1);
}

main().catch((err) => {
  console.error("[run-all-tests]", err);
  process.exit(1);
});
