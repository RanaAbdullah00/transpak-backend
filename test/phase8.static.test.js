/**
 * Phase 8 — Production stabilization static checks.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const frontendSrc = path.join(__dirname, "..", "..", "transpak-frontend", "src");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function readFe(rel) {
  return fs.readFileSync(path.join(frontendSrc, rel), "utf8");
}

describe("Phase 8 — ops telemetry & env", () => {
  it("opsTelemetry exports snapshot helpers", () => {
    const t = require("../utils/opsTelemetry");
    assert.equal(typeof t.getOpsSnapshot, "function");
    assert.equal(typeof t.recordHttpRequest, "function");
  });

  it("validateProductionEnv runs at server bootstrap", () => {
    const src = read("src/server.js");
    assert.ok(src.includes("validateProductionEnv"));
  });

  it("health endpoint exposes ops snapshot", () => {
    const src = read("src/app.js");
    assert.ok(src.includes("getOpsSnapshot"));
    assert.ok(src.includes("sockets"));
  });
});

describe("Phase 8 — socket hardening", () => {
  it("socket handlers rate-limit hot events", () => {
    const src = read("sockets/index.js");
    assert.ok(src.includes("allowSocketEvent"));
    assert.ok(src.includes('sock.leave(`user:${uid}:role:${other}`)'));
    assert.ok(src.includes("clearSocketRateLimits"));
  });

  it("frontend socket removes listeners on disconnect", () => {
    const src = readFe("services/socket.js");
    assert.ok(src.includes("socket.off"));
    assert.ok(src.includes("RECONNECT_REFRESH_MIN_MS"));
    assert.ok(src.includes("reconnectionAttempts"));
  });
});

describe("Phase 8 — cache & rate limits", () => {
  it("workspace cache prunes stale entries", () => {
    const src = readFe("utils/workspaceQueryCache.js");
    assert.ok(src.includes("pruneWorkspaceQueryCaches"));
    assert.ok(src.includes("MAX_ENTRIES"));
  });

  it("notifications route has dedicated limiter", () => {
    const src = read("routes/notificationRoutes.js");
    assert.ok(src.includes("notificationsRouteLimiter"));
  });

  it("global error handler hides stacks in production", () => {
    const src = read("utils/globalErrorHandler.js");
    assert.ok(src.includes("isProd"));
    assert.ok(src.includes("clientMessage"));
  });
});

describe("Phase 8 — deployment headers", () => {
  it("API responses set no-store cache control", () => {
    const src = read("middleware/deployHeaders.js");
    assert.ok(src.includes("no-store"));
  });

  it("helmet is enabled on express app", () => {
    const src = read("src/app.js");
    assert.ok(src.includes("helmet"));
  });

  it("CORS allows workspace header", () => {
    const src = read("src/app.js");
    assert.ok(src.includes("X-TransPak-Workspace"));
  });
});
