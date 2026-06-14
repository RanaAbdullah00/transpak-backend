/**
 * Phase 6 — Redis pub/sub fan-out with local reorder buffer (50–100ms).
 */
const crypto = require("crypto");
const realtimeHub = require("./realtimeHub");
const { getRedisClient } = require("../utils/redisClient");
const { recordReorderCorrection } = require("../utils/metricsCollector");

const CHANNEL = "transpak:realtime:v1";
const REORDER_MS = Number(process.env.SOCKET_REORDER_MS || 80);
const instanceId =
  String(process.env.RENDER_INSTANCE_ID || process.env.INSTANCE_ID || "").trim() ||
  crypto.randomBytes(6).toString("hex");

/** @type {Map<string, { timer: NodeJS.Timeout|null, items: object[] }>} */
const reorderBuffers = new Map();
let subscriberReady = false;

function localEmitTracking(io, payload) {
  if (!io || !payload) return;
  const refKey = String(payload.refKey || "").trim();
  if (!refKey) return;
  try {
    io.to(`track:${refKey}`).emit("tracking:update", payload);
    if (payload.shipmentId) {
      io.to(`shipment:${payload.shipmentId}`).emit("tracking:update", payload);
    }
  } catch {
    /* ignore */
  }
}

function flushReorderBuffer(refKey, io) {
  const buf = reorderBuffers.get(refKey);
  if (!buf) return;
  reorderBuffers.delete(refKey);
  if (buf.timer) clearTimeout(buf.timer);
  const sorted = [...buf.items].sort(
    (a, b) => Number(a.sequenceId || 0) - Number(b.sequenceId || 0)
  );
  if (sorted.length > 1) recordReorderCorrection();
  const winner = sorted[sorted.length - 1];
  if (winner) localEmitTracking(io, winner);
}

function scheduleReorderEmit(refKey, payload, io) {
  let buf = reorderBuffers.get(refKey);
  if (!buf) {
    buf = { timer: null, items: [] };
    reorderBuffers.set(refKey, buf);
  }
  buf.items.push(payload);
  if (buf.timer) return;
  buf.timer = setTimeout(() => flushReorderBuffer(refKey, io), REORDER_MS);
}

function emitTrackingUpdate(payload) {
  const io = realtimeHub.getIO();
  if (!io || !payload) return;
  const refKey = String(payload.refKey || "").trim();
  scheduleReorderEmit(refKey, payload, io);

  const redis = getRedisClient();
  if (redis.isEnabled()) {
    redis
      .publish(
        CHANNEL,
        JSON.stringify({
          origin: instanceId,
          type: "tracking:update",
          payload
        })
      )
      .catch(() => {});
  }
}

function initDistributedSocketBus() {
  if (subscriberReady) return;
  subscriberReady = true;
  const redis = getRedisClient();
  if (!redis.isEnabled()) return;

  try {
    const sub = redis.duplicate();
    sub.subscribe(CHANNEL);
    sub.on("message", (_, raw) => {
      try {
        const msg = JSON.parse(raw);
        if (!msg || msg.origin === instanceId) return;
        if (msg.type !== "tracking:update" || !msg.payload) return;
        const io = realtimeHub.getIO();
        const refKey = String(msg.payload.refKey || "").trim();
        scheduleReorderEmit(refKey, msg.payload, io);
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* degraded local-only */
  }
}

module.exports = {
  initDistributedSocketBus,
  emitTrackingUpdate,
  instanceId,
  CHANNEL
};
