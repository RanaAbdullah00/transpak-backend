/**
 * Phase 5 — in-memory client perf snapshot ingest (optional, disabled by default).
 */

const MAX_SNAPSHOTS = 32;
/** @type {Array<{ at: number, schema?: string, metrics?: object, coordinatorTrace?: object[] }>} */
const snapshots = [];

function isIngestEnabled() {
  return String(process.env.ENABLE_CLIENT_PERF_INGEST || "").toLowerCase() === "true";
}

function ingestClientPerfSnapshot(body = {}) {
  if (!isIngestEnabled()) {
    return { accepted: false, reason: "disabled" };
  }
  const entry = {
    at: Date.now(),
    schema: body.schema || "unknown",
    metrics: body.metrics || null,
    coordinatorTrace: Array.isArray(body.coordinatorTrace)
      ? body.coordinatorTrace.slice(-16)
      : []
  };
  snapshots.push(entry);
  while (snapshots.length > MAX_SNAPSHOTS) snapshots.shift();
  return { accepted: true };
}

function getClientPerfSnapshots() {
  return snapshots.slice();
}

function clearClientPerfSnapshots() {
  snapshots.length = 0;
}

module.exports = {
  ingestClientPerfSnapshot,
  getClientPerfSnapshots,
  clearClientPerfSnapshots,
  isIngestEnabled
};
