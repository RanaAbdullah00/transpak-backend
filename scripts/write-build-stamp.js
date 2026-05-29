#!/usr/bin/env node
/**
 * Baked into each Render build — commit identity survives without .git in container.
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function resolveCommit() {
  const fromEnv = String(
    process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || process.env.BUILD_ID || ""
  ).trim();
  if (fromEnv) return fromEnv;
  try {
    return execSync("git rev-parse HEAD", {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "unknown";
  }
}

const out = path.join(__dirname, "..", ".render-build-stamp.json");
try {
  fs.unlinkSync(out);
} catch {
  /* ignore — fresh stamp each build */
}

const commitFull = resolveCommit();
const stamp = {
  commitFull,
  commitShort: commitFull.slice(0, 12),
  builtAt: new Date().toISOString(),
  nodeVersion: process.version,
  schemaVersion: "023",
  render: Boolean(process.env.RENDER)
};

fs.writeFileSync(out, `${JSON.stringify(stamp, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log("[build] stamp written", out, stamp.commitShort);
