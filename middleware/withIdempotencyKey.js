/**
 * Phase 6 — write idempotency middleware (additive, optional headers/body keys).
 */
const { getIdempotentResponse, saveIdempotentResponse } = require("../utils/idempotencyStore");

function extractIdempotencyKey(req) {
  return (
    String(req.headers["idempotency-key"] || req.headers["x-idempotency-key"] || "").trim() ||
    String(req.body?.idempotencyKey || req.body?.idempotency_key || "").trim() ||
    String(req.body?.eventId || req.body?.event_id || "").trim() ||
    null
  );
}

function withIdempotencyKey(scope = "default") {
  return async function idempotencyMiddleware(req, res, next) {
    const key = extractIdempotencyKey(req);
    if (!key) return next();

    req.idempotencyKey = key;
    req.eventId = String(req.body?.eventId || req.body?.event_id || key).trim();

    try {
      const existing = await getIdempotentResponse(scope, key);
      if (existing) {
        return res.status(existing.statusCode).json(existing.responseBody);
      }
    } catch {
      /* proceed on store read failure */
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        saveIdempotentResponse(scope, key, res.statusCode, body).catch(() => {});
      }
      return originalJson(body);
    };
    return next();
  };
}

module.exports = { withIdempotencyKey, extractIdempotencyKey };
