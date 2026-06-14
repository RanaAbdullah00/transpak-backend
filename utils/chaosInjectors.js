/**
 * Phase 7 — chaos injectors (test/dev only, gated by CHAOS_ENABLED).
 */

function isChaosEnabled() {
  return String(process.env.CHAOS_ENABLED || "").trim() === "1";
}

function wrapRedisChaos(redis, { dropPubSubRate = 0, latencyMs = 0 } = {}) {
  if (!isChaosEnabled()) return redis;
  return {
    ...redis,
    async publish(ch, msg) {
      if (Math.random() < dropPubSubRate) return 0;
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      return redis.publish(ch, msg);
    },
    async incr(key) {
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      return redis.incr(key);
    }
  };
}

function duplicateEmissions(emitFn, payload, times = 2) {
  if (!isChaosEnabled()) return emitFn(payload);
  for (let i = 0; i < times; i += 1) emitFn(payload);
}

function corruptEvent(event, { stripParent = false, badSequence = false } = {}) {
  const copy = { ...event };
  if (stripParent) copy.parentEventId = null;
  if (badSequence) copy.sequenceId = -1;
  return copy;
}

module.exports = {
  isChaosEnabled,
  wrapRedisChaos,
  duplicateEmissions,
  corruptEvent
};
