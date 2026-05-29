/**
 * Phase 8 — lightweight operational metrics (in-process, no PII).
 */
const SLOW_MS = Number(process.env.OPS_SLOW_REQUEST_MS || 2000);
const RING_MAX = Number(process.env.OPS_RING_MAX || 100);

const counters = {
  httpTotal: 0,
  http5xx: 0,
  http4xx: 0,
  slowRequests: 0,
  authFailures: 0,
  socketConnects: 0,
  socketDisconnects: 0,
  socketRateLimited: 0,
  dispatchFailures: 0
};

const ring = [];

function pushEvent(event, meta = {}) {
  ring.push({
    ts: new Date().toISOString(),
    event: String(event).slice(0, 48),
    ...meta
  });
  if (ring.length > RING_MAX) ring.shift();
}

function recordHttpRequest(method, path, statusCode, durationMs) {
  counters.httpTotal += 1;
  const status = Number(statusCode) || 0;
  if (status >= 500) counters.http5xx += 1;
  else if (status >= 400) counters.http4xx += 1;
  const ms = Number(durationMs) || 0;
  if (ms >= SLOW_MS) {
    counters.slowRequests += 1;
    pushEvent("slow_request", { method, path: String(path || "").slice(0, 120), status, ms });
  }
}

function recordAuthFailure(reason = "unknown") {
  counters.authFailures += 1;
  pushEvent("auth_failure", { reason: String(reason).slice(0, 32) });
}

function recordSocketConnect() {
  counters.socketConnects += 1;
}

function recordSocketDisconnect(reason = "") {
  counters.socketDisconnects += 1;
  if (reason && reason !== "client namespace disconnect") {
    pushEvent("socket_disconnect", { reason: String(reason).slice(0, 48) });
  }
}

function recordSocketRateLimited(eventName) {
  counters.socketRateLimited += 1;
  pushEvent("socket_rate_limited", { event: String(eventName).slice(0, 32) });
}

function recordDispatchFailure(detail = "") {
  counters.dispatchFailures += 1;
  pushEvent("dispatch_failure", { detail: String(detail).slice(0, 80) });
}

function getOpsSnapshot({ includeRecent = true } = {}) {
  let connectedSockets = 0;
  try {
    const hub = require("../services/realtimeHub");
    connectedSockets = hub.getConnectedSocketCount();
  } catch {
    // ignore
  }
  return {
    uptimeSeconds: Math.floor(process.uptime()),
    connectedSockets,
    counters: { ...counters },
    slowThresholdMs: SLOW_MS,
    recent: includeRecent ? ring.slice(-20) : undefined
  };
}

module.exports = {
  recordHttpRequest,
  recordAuthFailure,
  recordSocketConnect,
  recordSocketDisconnect,
  recordSocketRateLimited,
  recordDispatchFailure,
  getOpsSnapshot,
  SLOW_MS
};
