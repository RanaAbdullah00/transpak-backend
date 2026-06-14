/**
 * Phase 7 — HTTP trace middleware (X-Trace-Id propagation).
 */
const { bindTrace, createTraceId } = require("../utils/traceContext");
const { recordSpan } = require("../utils/traceStore");

function traceMiddleware(req, res, next) {
  const incoming = String(req.headers["x-trace-id"] || req.headers["x-request-id"] || "").trim();
  const traceId = bindTrace(incoming || createTraceId());
  res.setHeader("X-Trace-Id", traceId);
  recordSpan("request_start", {
    method: req.method,
    path: req.originalUrl || req.url
  });
  next();
}

module.exports = { traceMiddleware };
