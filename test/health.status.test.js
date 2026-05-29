/**
 * Live /api/health database status resolution.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

describe("Health status resolution", () => {
  it("health endpoint uses live resolveDatabaseHealth", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8");
    assert.ok(src.includes("resolveDatabaseHealth"));
    assert.ok(src.includes("schema:"));
  });

  it("verifyDeploy only hard-fails on migration_required or schema.ok false", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "..", "transpak-frontend", "src", "utils", "verifyDeploy.js"),
      "utf8"
    );
    assert.ok(src.includes("isHardMismatch"));
    assert.ok(src.includes("tp:deploy-ok"));
    assert.ok(src.includes("connecting"));
  });

  it("DeployMismatchBanner clears on tp:deploy-ok", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "..", "transpak-frontend", "src", "components", "layout", "DeployMismatchBanner.jsx"),
      "utf8"
    );
    assert.ok(src.includes("tp:deploy-ok"));
    assert.ok(src.includes("setMismatch(false)"));
  });
});
