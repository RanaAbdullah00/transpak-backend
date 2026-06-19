#!/usr/bin/env node
/**
 * Run backend tests with integration preflight (sets INTEGRATION_SERVER_READY).
 * Spawns a dedicated bypass-enabled server when the probed API lacks test bypass.
 */
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");
const require = createRequire(path.join(backendRoot, "package.json"));

require("dotenv").config({ path: path.join(backendRoot, ".env") });

const { hasIntegrationEnv } = require(path.join(backendRoot, "test/helpers/config.js"));
const {
  serverHasIntegrationBypass
} = require(path.join(backendRoot, "test/helpers/serverReachable.js"));

const TEST_PORT = Number(process.env.INTEGRATION_TEST_PORT || 10100);
const TEST_BASE = `http://127.0.0.1:${TEST_PORT}`;

const HEALTH_PROBE_MS = Number(process.env.INTEGRATION_HEALTH_TIMEOUT_MS || 20000);

function killPortListener(port) {
  if (process.platform === "win32") {
    const out = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }`
      ],
      { stdio: "ignore" }
    );
    return out.status === 0;
  }
  const out = spawnSync("bash", ["-lc", `fuser -k ${port}/tcp 2>/dev/null || true`], { stdio: "ignore" });
  return out.status === 0;
}

async function waitForBypassServer({ timeoutMs = 60000, ports = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  const scan =
    ports ||
    Array.from({ length: 16 }, (_, i) => TEST_PORT + i);
  while (Date.now() < deadline) {
    for (const port of scan) {
      const base = `http://127.0.0.1:${port}`;
      if (await serverHasIntegrationBypass(base, { timeoutMs: HEALTH_PROBE_MS })) {
        return base;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function main() {
  const testEnv = { ...process.env };
  let child = null;

  if (!hasIntegrationEnv()) {
    testEnv.INTEGRATION_SERVER_READY = "0";
    console.log("[run-all-tests] No E2E credentials — HTTP suites will skip.");
  } else {
    // Always spawn a fresh dedicated test backend (never reuse dev npm start / stale pool).
    killPortListener(TEST_PORT);
    await new Promise((r) => setTimeout(r, 500));

    console.log(`[run-all-tests] Starting test backend with integration bypass (from ${TEST_BASE})...`);
    child = spawn(process.execPath, ["server.js"], {
      cwd: backendRoot,
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        NODE_ENV: "development",
        INTEGRATION_SERVER_READY: "1",
        DISABLE_LOGIN_RATE_LIMIT: "1",
        PG_POOL_MAX: process.env.PG_POOL_MAX || "4"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout?.on("data", (d) => process.stdout.write(d));
    child.stderr?.on("data", (d) => process.stderr.write(d));
    const base = await waitForBypassServer({
      timeoutMs: 60000,
      ports: [TEST_PORT]
    });
    if (!base) {
      console.error("[run-all-tests] Failed to start bypass-enabled test backend");
      child.kill("SIGTERM");
      process.exit(1);
    }

    await new Promise((r) => setTimeout(r, 2000));

    testEnv.QA_BASE_URL = base;
    testEnv.INTEGRATION_SERVER_READY = "1";
    testEnv.DISABLE_LOGIN_RATE_LIMIT = "1";
    testEnv.PG_POOL_MAX = testEnv.PG_POOL_MAX || "2";
    console.log(`[run-all-tests] Integration API OK — ${base} (bypass active)`);
  }

  const result = spawnSync(
    process.execPath,
    ["--test", "--test-concurrency=1", "test/*.test.js"], {
    cwd: backendRoot,
    stdio: "inherit",
    env: testEnv
  });

  if (child) {
    child.kill("SIGTERM");
  }

  process.exit(result.status ?? 1);
}

main().catch((err) => {
  console.error("[run-all-tests]", err);
  process.exit(1);
});
