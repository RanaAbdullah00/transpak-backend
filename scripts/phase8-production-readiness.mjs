#!/usr/bin/env node
/**
 * Phase 8 — production readiness probe (health + static env + unit checks).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");
const require = createRequire(path.join(backendRoot, "package.json"));
require("dotenv").config({ path: path.join(backendRoot, ".env") });

const { getBaseUrl } = require("../test/helpers/config");
const { validateProductionEnv } = require("../utils/validateProductionEnv");

const results = [];

function record(id, pass, detail) {
  results.push({ id, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} [${id}] ${detail}`);
}

function runStaticTests() {
  const r = spawnSync(
    process.execPath,
    ["--test", "test/phase8.static.test.js"],
    { cwd: backendRoot, stdio: "inherit" }
  );
  record("static-tests", r.status === 0, `exit ${r.status ?? 1}`);
}

async function probeHealth() {
  const base = getBaseUrl();
  try {
    const res = await fetch(`${base}/api/health`, {
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
    const data = await res.json();
    const body = JSON.stringify(data || {});
    const leaksStack = /at\s+[\w.]+\s+\(|\.js:\d+:\d+/.test(body);
    record("health-status", res.ok, `HTTP ${res.status}`);
    record("health-no-stack", !leaksStack, leaksStack ? "response may leak stack" : "clean envelope");
    record("health-ops", data?.data?.ops != null, `ops counters present`);
    record("health-sockets", typeof data?.data?.sockets === "number", `sockets=${data?.data?.sockets}`);
  } catch (err) {
    record("health-status", false, err?.message || String(err));
  }
}

console.log("Phase 8 production readiness");
const env = validateProductionEnv();
record("env-validation", env.ok || process.env.NODE_ENV !== "production", env.issues.join("; ") || "ok");

runStaticTests();
await probeHealth();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
