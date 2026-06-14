/**
 * Phase 6 — centralized metrics sink (backend authoritative).
 */
const { getRedisMode } = require("./redisClient");

const metrics = {
  rating: {
    batchRequestCount: 0,
    batchLatencyTotalMs: 0,
    batchCacheHits: 0,
    batchCacheMisses: 0,
    userDensityTotal: 0
  },
  tracking: {
    eventThroughput: 0,
    reorderCorrections: 0,
    duplicateBlockedCount: 0,
    rehydrateFrequency: 0,
    sourceSwitchRate: 0
  },
  infrastructure: {
    redisMode: "memory",
    clientIngestCount: 0
  },
  updatedAt: 0
};

function touch() {
  metrics.updatedAt = Date.now();
  metrics.infrastructure.redisMode = getRedisMode();
}

function recordRatingBatch({ userCount = 0, durationMs = 0, cacheHits = 0, cacheMisses = 0 } = {}) {
  metrics.rating.batchRequestCount += 1;
  metrics.rating.batchLatencyTotalMs += Number(durationMs) || 0;
  metrics.rating.batchCacheHits += Number(cacheHits) || 0;
  metrics.rating.batchCacheMisses += Number(cacheMisses) || 0;
  metrics.rating.userDensityTotal += Number(userCount) || 0;
  touch();
}

function recordTrackingEvent() {
  metrics.tracking.eventThroughput += 1;
  touch();
}

function recordReorderCorrection() {
  metrics.tracking.reorderCorrections += 1;
  touch();
}

function recordDuplicateBlocked() {
  metrics.tracking.duplicateBlockedCount += 1;
  touch();
}

function recordRehydrate() {
  metrics.tracking.rehydrateFrequency += 1;
  touch();
}

function recordSourceSwitch() {
  metrics.tracking.sourceSwitchRate += 1;
  touch();
}

function ingestClientMetrics(payload = {}) {
  metrics.infrastructure.clientIngestCount += 1;
  const traceId = payload.traceId || payload.metrics?.traceId;
  if (traceId) {
    try {
      const { persistSpan } = require("./traceStore");
      persistSpan({
        traceId,
        spanName: "client_apply",
        shipmentId: payload.shipmentId || payload.metrics?.shipmentId || null,
        metadata: { source: "client_ingest" }
      }).catch(() => {});
    } catch {
      /* ignore */
    }
  }
  const rating = payload.metrics?.rating || payload.rating;
  const tracking = payload.metrics?.tracking || payload.tracking;
  if (rating) {
    metrics.rating.batchRequestCount += Number(rating.batchRequestCount) || 0;
    metrics.rating.batchCacheHits += Number(rating.batchCacheHits) || 0;
    metrics.rating.batchCacheMisses += Number(rating.batchCacheMisses) || 0;
  }
  if (tracking) {
    metrics.tracking.eventThroughput += Number(tracking.socketEventCount) || 0;
    metrics.tracking.duplicateBlockedCount += Number(tracking.dedupeSkippedCount) || 0;
    metrics.tracking.rehydrateFrequency += Number(tracking.rehydrateCount) || 0;
    metrics.tracking.sourceSwitchRate += Number(tracking.activeSourceTransitions) || 0;
  }
  touch();
}

function getMetricsSnapshot() {
  const r = metrics.rating;
  const batchCount = r.batchRequestCount || 0;
  const cacheTotal = r.batchCacheHits + r.batchCacheMisses;
  return {
    rating: {
      batchRequestCount: r.batchRequestCount,
      batchLatencyAvg: batchCount ? Math.round(r.batchLatencyTotalMs / batchCount) : 0,
      cacheHitRatio: cacheTotal ? Number((r.batchCacheHits / cacheTotal).toFixed(4)) : 0,
      userDensityPerBatch: batchCount ? Math.round(r.userDensityTotal / batchCount) : 0
    },
    tracking: { ...metrics.tracking },
    infrastructure: { ...metrics.infrastructure },
    updatedAt: metrics.updatedAt
  };
}

function toPrometheusLines() {
  const s = getMetricsSnapshot();
  return [
    `# HELP transpak_rating_batch_requests Total batched rating summary requests`,
    `# TYPE transpak_rating_batch_requests counter`,
    `transpak_rating_batch_requests ${s.rating.batchRequestCount}`,
    `# HELP transpak_tracking_duplicate_blocked Duplicate tracking events blocked`,
    `# TYPE transpak_tracking_duplicate_blocked counter`,
    `transpak_tracking_duplicate_blocked ${s.tracking.duplicateBlockedCount}`,
    `# HELP transpak_tracking_event_throughput Tracking events processed`,
    `# TYPE transpak_tracking_event_throughput counter`,
    `transpak_tracking_event_throughput ${s.tracking.eventThroughput}`
  ].join("\n");
}

module.exports = {
  recordRatingBatch,
  recordTrackingEvent,
  recordReorderCorrection,
  recordDuplicateBlocked,
  recordRehydrate,
  recordSourceSwitch,
  ingestClientMetrics,
  getMetricsSnapshot,
  toPrometheusLines
};
