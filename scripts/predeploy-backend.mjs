#!/usr/bin/env node
/**
 * Pre-deploy gate: ensure backend deploy-critical files are committed and pushed.
 * Usage: npm run predeploy:check  (from transpak-backend)
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const backendRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.join(backendRoot, "..");

const CRITICAL_PATHS = [
  "transpak-backend/server.js",
  "transpak-backend/src/server.js",
  "transpak-backend/src/app.js",
  "transpak-backend/utils/deployIdentity.js",
  "transpak-backend/utils/healthStatus.js",
  "transpak-backend/utils/normalizeCommit.js",
  "transpak-backend/config/dbBootstrap.js",
  "transpak-backend/config/db.js",
  "transpak-backend/db/migrate.js",
  "transpak-backend/db/schemaGuard.js",
  "transpak-backend/render.yaml",
  "render.yaml"
];

function run(cmd, cwd = repoRoot) {
  return execSync(cmd, { cwd, encoding: "utf8" }).trim();
}

function main() {
  console.log("=== TransPak backend pre-deploy check ===\n");

  let exitCode = 0;
  const localFull = run("git rev-parse HEAD");
  const localShort = run("git rev-parse --short HEAD");
  console.log("Local HEAD:", localFull);
  console.log("Local short:", localShort);

  let remoteMain = "";
  try {
    run("git fetch origin main --quiet 2>nul || git fetch origin main --quiet");
    remoteMain = run("git rev-parse origin/main");
    console.log("origin/main:", remoteMain);
    if (localFull !== remoteMain) {
      console.warn("\nWARN: Local HEAD is not pushed to origin/main.");
      console.warn("  Run: git push origin main");
      exitCode = 1;
    } else {
      console.log("OK: origin/main matches local HEAD");
    }
  } catch (e) {
    console.warn("Could not compare origin/main:", e.message);
  }

  console.log("\n--- Critical paths (must be committed) ---");
  const status = run("git status --porcelain");

  for (const rel of CRITICAL_PATHS) {
    const abs = path.join(repoRoot, rel);
    const exists = fs.existsSync(abs);
    const statusLine = status.split("\n").find((line) => {
      const f = line.slice(3).trim();
      return f === rel || f.replace(/\\/g, "/") === rel;
    });
    const isUntracked = statusLine?.startsWith("??");
    const isModified = statusLine && !isUntracked;

    if (!exists) {
      console.log(`MISSING  ${rel}`);
      exitCode = 1;
    } else if (isUntracked || isModified) {
      console.log(`NOT READY ${rel} (${isUntracked ? "untracked" : "modified"})`);
      exitCode = 1;
    } else {
      console.log(`OK       ${rel}`);
    }
  }

  console.log("\n--- Render deploy checklist ---");
  console.log("1. git add transpak-backend render.yaml");
  console.log("2. git commit -m \"Deploy: backend health, migrations, deploy identity\"");
  console.log("3. git push origin main");
  console.log("4. Render Dashboard → Manual Deploy → Clear build cache");
  console.log("5. Confirm logs show: [deploy] commit=<hash> [deploy] time=<iso>");
  console.log("6. npm run verify:production");

  if (exitCode) {
    console.error("\nFAIL: Push all backend changes before deploying Render.");
    process.exit(1);
  }
  console.log("\nPASS: Backend is ready to deploy from Git.");
  process.exit(0);
}

main();
