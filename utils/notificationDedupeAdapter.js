/**
 * Phase 4 — notification dedupe adapter (in-memory default; Redis placeholder for multi-instance).
 */

const DEDUPE_WINDOW_MS = Number(process.env.NOTIFY_DEDUPE_MS || 120000);

class InMemoryAdapter {
  constructor(windowMs = DEDUPE_WINDOW_MS) {
    this.windowMs = windowMs;
    /** @type {Map<string, number>} */
    this.map = new Map();
  }

  has(eventId) {
    const key = String(eventId || "").trim();
    if (!key) return false;
    const ts = this.map.get(key);
    if (ts == null) return false;
    if (Date.now() - ts > this.windowMs) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  set(eventId, at = Date.now()) {
    const key = String(eventId || "").trim();
    if (!key) return;
    this.map.set(key, at);
    this.clearExpired(at);
  }

  clearExpired(now = Date.now()) {
    if (this.map.size < 5000) return;
    for (const [k, ts] of this.map) {
      if (now - ts > this.windowMs) this.map.delete(k);
    }
  }

  cleanup(now = Date.now()) {
    this.clearExpired(now);
  }
}

/** Future multi-instance adapter — NOT ACTIVE until Redis wiring is complete. */
class RedisAdapter {
  constructor() {
    this.enabled = false;
  }

  has() {
    throw new Error("RedisAdapter is not active — set NOTIFY_DEDUPE_REDIS after Redis wiring");
  }

  set() {
    throw new Error("RedisAdapter is not active — set NOTIFY_DEDUPE_REDIS after Redis wiring");
  }

  clearExpired() {
    return Promise.resolve();
  }

  cleanup() {
    return Promise.resolve();
  }
}

function createNotificationDedupeAdapter() {
  if (process.env.NOTIFY_DEDUPE_REDIS === "1") {
    // eslint-disable-next-line no-console
    console.warn(
      "[notify] NOTIFY_DEDUPE_REDIS=1 but RedisAdapter is not wired — using InMemoryAdapter"
    );
  }
  return new InMemoryAdapter();
}

module.exports = {
  InMemoryAdapter,
  RedisAdapter,
  createNotificationDedupeAdapter,
  DEDUPE_WINDOW_MS
};
