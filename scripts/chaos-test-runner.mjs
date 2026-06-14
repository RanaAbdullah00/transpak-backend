#!/usr/bin/env node
/**
 * Phase 7 — chaos test runner (local validation).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");

process.env.CHAOS_ENABLED = "1";

const result = spawnSync(
  process.execPath,
  ["--test", "test/phase7-enterprise.chaos.test.js", "test/phase7-enterprise.strict.test.js"],
  { cwd: backendRoot, stdio: "inherit", env: { ...process.env, CHAOS_ENABLED: "1" } }
);

if (result.status !== 0) {
  console.error("[chaos] FAILED");
  process.exit(result.status || 1);
}
console.log("[chaos] PASS");
process.exit(0);
