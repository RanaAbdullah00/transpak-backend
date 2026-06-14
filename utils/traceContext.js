/**
 * Phase 7 — lightweight distributed trace context (AsyncLocalStorage).
 */
const { AsyncLocalStorage } = require("async_hooks");
const crypto = require("crypto");

const storage = new AsyncLocalStorage();

function createTraceId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return crypto.randomBytes(16).toString("hex");
}

function getTraceId() {
  return storage.getStore()?.traceId || null;
}

function runWithTrace(traceId, fn) {
  const id = String(traceId || createTraceId()).slice(0, 64);
  return storage.run({ traceId: id }, fn);
}

function bindTrace(traceId) {
  const id = String(traceId || createTraceId()).slice(0, 64);
  storage.enterWith({ traceId: id });
  return id;
}

module.exports = {
  createTraceId,
  getTraceId,
  runWithTrace,
  bindTrace
};
