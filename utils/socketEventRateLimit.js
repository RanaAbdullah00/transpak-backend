/**
 * Per-socket event rate limiting (reconnect / spam protection).
 */
const { recordSocketRateLimited } = require("./opsTelemetry");

const DEFAULTS = {
  "workspace:join": { windowMs: 10_000, max: 12 },
  "chat:join": { windowMs: 60_000, max: 40 },
  "tracking:join": { windowMs: 60_000, max: 60 },
  "tracking:location": { windowMs: 60_000, max: Number(process.env.GPS_SOCKET_MAX_PER_MIN || 90) },
  "chat:seen": { windowMs: 60_000, max: 80 }
};

/** @type {WeakMap<object, Map<string, { count: number, resetAt: number }>>} */
const buckets = new WeakMap();

function getBucket(socket, eventName) {
  let map = buckets.get(socket);
  if (!map) {
    map = new Map();
    buckets.set(socket, map);
  }
  const key = eventName;
  let b = map.get(key);
  const now = Date.now();
  const rule = DEFAULTS[eventName] || { windowMs: 60_000, max: 120 };
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + rule.windowMs };
    map.set(key, b);
  }
  return { bucket: b, rule };
}

function allowSocketEvent(socket, eventName) {
  const { bucket, rule } = getBucket(socket, eventName);
  bucket.count += 1;
  if (bucket.count > rule.max) {
    recordSocketRateLimited(eventName);
    return false;
  }
  return true;
}

function clearSocketRateLimits(socket) {
  buckets.delete(socket);
}

module.exports = { allowSocketEvent, clearSocketRateLimits };
