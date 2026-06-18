#!/usr/bin/env node
/**
 * Wait for local API health, optionally spawn test backend with rate-limit bypass, then run full suite.
 */
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");
const require = createRequire(path.join(backendRoot, "package.json"));

require("dotenv").config({ path: path.join(backendRoot, ".env") });

const { getBaseUrl, hasIntegrationEnv, skipIntegrationReason } = require(path.join(backendRoot, "test/helpers/config.js"));
const { waitForServer, isServerReachable } = require(path.join(backendRoot, "test/helpers/serverReachable.js"));

const TEST_PORT = Number(process.env.INTEGRATION_TEST_PORT || 10100);
const TEST_BASE = `http://127.0.0.1:${TEST_PORT}`;

async function main() {
  if (!hasIntegrationEnv()) {
    console.error("[test:integration]", skipIntegrationReason());
    process.exit(1);
  }

  let base = String(process.env.QA_BASE_URL || process.env.TEST_BASE_URL || getBaseUrl() || TEST_BASE).replace(/\/$/, "");
  let child = null;

  const probe = await isServerReachable(base);
  const probeHasBypass = probe && (await fetch(`${base}/api/health`).then(() => true).catch(() => false));

  if (!probe || !process.env.QA_BASE_URL) {
    console.log(`[test:integration] Starting test backend on ${TEST_BASE} with rate-limit bypass...`);
    child = spawn(process.execPath, ["server.js"], {
      cwd: backendRoot,
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        NODE_ENV: "development",
        INTEGRATION_SERVER_READY: "1",
        DISABLE_LOGIN_RATE_LIMIT: "1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout?.on("data", (d) => process.stdout.write(d));
    child.stderr?.on("data", (d) => process.stderr.write(d));
    base = TEST_BASE;
    const ready = await waitForServer(base, { timeoutMs: 60000 });
    if (!ready) {
      console.error("[test:integration] Failed to start test backend");
      child.kill("SIGTERM");
      process.exit(1);
    }
  } else if (!probeHasBypass) {
    console.warn(
      `[test:integration] Using ${base} — ensure server started with INTEGRATION_SERVER_READY=1 DISABLE_LOGIN_RATE_LIMIT=1`
    );
  }

  process.env.QA_BASE_URL = base;
  process.env.INTEGRATION_SERVER_READY = "1";
  process.env.DISABLE_LOGIN_RATE_LIMIT = "1";
  console.log(`[test:integration] Running tests against ${base}`);

  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["test"], {
    cwd: backendRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      INTEGRATION_SERVER_READY: "1",
      DISABLE_LOGIN_RATE_LIMIT: "1",
      QA_BASE_URL: base
    }
  });

  if (child) {
    child.kill("SIGTERM");
  }

  process.exit(result.status ?? 1);
}

main().catch((err) => {
  console.error("[test:integration]", err);
  process.exit(1);
});
