/**
 * Lightweight in-memory audit ring for notification insert outcomes (non-blocking).
 * Source-of-truth remains DB; this buffer aids partial-failure diagnostics.
 */
const RING_SIZE = Number(process.env.NOTIFY_AUDIT_RING_SIZE || 500);

/** @type {Array<object>} */
const buffer = [];

function record(entry) {
  const row = {
    eventType: entry.eventType || null,
    entityId: entry.entityId || null,
    receiverId: entry.receiverId || null,
    dedupeKey: entry.dedupeKey || null,
    status: entry.status === "success" ? "success" : "fail",
    at: new Date().toISOString(),
    error: entry.error ? String(entry.error).slice(0, 240) : null
  };
  buffer.push(row);
  if (buffer.length > RING_SIZE) buffer.shift();
  return row;
}

function snapshot(limit = 50) {
  const n = Math.min(RING_SIZE, Math.max(1, Number(limit) || 50));
  return buffer.slice(-n);
}

function stats() {
  const recent = buffer.slice(-100);
  const success = recent.filter((r) => r.status === "success").length;
  const fail = recent.filter((r) => r.status === "fail").length;
  return { ringSize: RING_SIZE, buffered: buffer.length, recentSuccess: success, recentFail: fail };
}

module.exports = { record, snapshot, stats };
