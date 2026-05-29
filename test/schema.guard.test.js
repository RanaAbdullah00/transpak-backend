/**
 * Migration architecture — read-only guard on startup, tracked runner on db:migrate.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");

describe("Migration system architecture", () => {
  it("schemaGuard is read-only (no ALTER/INSERT migrations)", () => {
    const src = fs.readFileSync(path.join(root, "db", "schemaGuard.js"), "utf8");
    assert.ok(src.includes("verifySchema"));
    assert.ok(!src.includes("applyMigrationFile"));
    assert.ok(!src.includes("ALTER TABLE"));
    assert.ok(!src.includes("INSERT INTO"));
  });

  it("connectDB does NOT run migrations on startup", () => {
    const src = fs.readFileSync(path.join(root, "config", "db.js"), "utf8");
    assert.ok(src.includes("verifySchema"));
    assert.ok(!src.includes("runMigrations"));
  });

  it("migrate.js tracks schema_migrations with SERIAL id", () => {
    const src = fs.readFileSync(path.join(root, "db", "migrate.js"), "utf8");
    assert.ok(src.includes("id SERIAL PRIMARY KEY"));
    assert.ok(src.includes("schema_migrations"));
    assert.ok(src.includes("isMigrationApplied"));
    assert.ok(src.includes("024_truck_status_constraint_reconcile.sql"));
    assert.ok(src.includes("BEGIN"));
  });

  it("migrate.js uses migration_lock with FOR UPDATE", () => {
    const src = fs.readFileSync(path.join(root, "db", "migrate.js"), "utf8");
    assert.ok(src.includes("migration_lock"));
    assert.ok(src.includes("FOR UPDATE"));
    assert.ok(src.includes("releaseMigrationLock"));
    assert.ok(src.includes("MigrationLockHeldError"));
  });

  it("server does not throw on schema mismatch (safe boot)", () => {
    const dbSrc = fs.readFileSync(path.join(root, "config", "db.js"), "utf8");
    assert.ok(dbSrc.includes("needsMigration"));
    assert.ok(!dbSrc.includes("runMigrations"));
    const srv = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
    assert.ok(srv.includes("needsMigration"));
    assert.ok(!srv.includes("SCHEMA_MIGRATION_REQUIRED"));
    assert.ok(srv.includes("startDbInit"));
    assert.ok(!srv.includes("connectWithRetry"));
    assert.ok(!srv.includes("setTimeout(connect"));
  });

  it("020 migration uses canonical trucks status constraint only", () => {
    const sql = fs.readFileSync(path.join(root, "db", "migrations", "020_truck_fleet_status.sql"), "utf8");
    assert.ok(sql.includes("CHECK (status IN ('pending', 'approved', 'suspended'))"));
    assert.ok(!/CHECK\s*\([^)]*pending_verification/i.test(sql));
    assert.ok(!/CHECK\s*\([^)]*'active'/i.test(sql));
  });

  it("023 migration uses safe ADD COLUMN IF NOT EXISTS", () => {
    const sql = fs.readFileSync(path.join(root, "db", "migrations", "023_notifications_realtime.sql"), "utf8");
    assert.ok(sql.includes("ADD COLUMN IF NOT EXISTS dedupe_key"));
    assert.ok(!/\bDROP TABLE\b/i.test(sql));
  });

  it("render startCommand runs db:migrate before node server.js", () => {
    const yaml = fs.readFileSync(path.join(root, "render.yaml"), "utf8");
    assert.ok(yaml.includes("npm run db:migrate"));
    assert.ok(yaml.includes("node server.js"));
  });

  it("health exposes schema status and migrationSafe deploy flag", () => {
    const src = fs.readFileSync(path.join(root, "src", "app.js"), "utf8");
    assert.ok(src.includes("migrationRequired"));
    assert.ok(src.includes("schemaVersion"));
    assert.ok(src.includes("migrationSafe"));
    assert.ok(src.includes("deploymentStatus"));
    assert.ok(src.includes("healthPhase"));
    assert.ok(src.includes("booting"));
  });

  it("health waits for db bootstrap before final schema", () => {
    const src = fs.readFileSync(path.join(root, "utils", "healthStatus.js"), "utf8");
    assert.ok(src.includes("waitForDbInit"));
    assert.ok(src.includes("bootingHealth"));
  });

  it("connectDB does not throw on connection failure (safe boot)", () => {
    const src = fs.readFileSync(path.join(root, "config", "db.js"), "utf8");
    assert.ok(!src.includes("throw err"));
  });

  it("deployIdentity resolves git commit with fallback", () => {
    const src = fs.readFileSync(path.join(root, "utils", "deployIdentity.js"), "utf8");
    assert.ok(src.includes("git rev-parse HEAD"));
    assert.ok(src.includes("RENDER_GIT_COMMIT"));
    assert.ok(src.includes("getDeploymentStatus"));
    assert.ok(src.includes("commitShort"));
    assert.ok(src.includes("normalizedCommit"));
  });

  it("normalizeCommit matches full and short SHA", () => {
    const { normalizeCommit, commitsMatch } = require(path.join(root, "utils", "normalizeCommit.js"));
    const full = "a9b37cf578db706a3bfaa87550ac8f55bb5ce8eb";
    const short = "a9b37cf578db";
    assert.equal(normalizeCommit(full), normalizeCommit(short));
    assert.equal(commitsMatch(full, short), true);
    assert.equal(commitsMatch(full, "deadbeef0000"), false);
  });
});
