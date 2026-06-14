/**
 * Phase 6 — idempotency store (Redis cache + DB authoritative fallback).
 */
const { query } = require("../db/pool");
const { getRedisClient } = require("./redisClient");

const REDIS_TTL_SEC = Number(process.env.IDEMPOTENCY_REDIS_TTL_SEC || 300);

function cacheKey(scope, key) {
  return `idempotency:${scope}:${key}`;
}

async function getIdempotentResponse(scope, idempotencyKey) {
  const scopeKey = String(scope || "default").slice(0, 64);
  const key = String(idempotencyKey || "").trim().slice(0, 240);
  if (!key) return null;

  const redis = getRedisClient();
  if (redis.isEnabled()) {
    try {
      const cached = await redis.get(cacheKey(scopeKey, key));
      if (cached) return JSON.parse(cached);
    } catch {
      /* ignore */
    }
  }

  try {
    const { rows } = await query(
      `SELECT status_code AS "statusCode", response_body AS "responseBody"
       FROM idempotency_keys
       WHERE scope = $1 AND idempotency_key = $2 AND expires_at > now()
       LIMIT 1`,
      [scopeKey, key]
    );
    return rows[0]
      ? { statusCode: rows[0].statusCode, responseBody: rows[0].responseBody }
      : null;
  } catch {
    return null;
  }
}

async function saveIdempotentResponse(scope, idempotencyKey, statusCode, responseBody) {
  const scopeKey = String(scope || "default").slice(0, 64);
  const key = String(idempotencyKey || "").trim().slice(0, 240);
  if (!key) return;

  const record = { statusCode, responseBody };
  const redis = getRedisClient();
  if (redis.isEnabled()) {
    try {
      await redis.set(cacheKey(scopeKey, key), JSON.stringify(record), "EX", REDIS_TTL_SEC);
    } catch {
      /* ignore */
    }
  }

  try {
    await query(
      `INSERT INTO idempotency_keys (scope, idempotency_key, status_code, response_body)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (scope, idempotency_key)
       DO UPDATE SET status_code = EXCLUDED.status_code,
                     response_body = EXCLUDED.response_body,
                     created_at = now(),
                     expires_at = now() + interval '24 hours'`,
      [scopeKey, key, statusCode, responseBody]
    );
  } catch {
    /* table may be missing before migration — non-fatal */
  }
}

module.exports = {
  getIdempotentResponse,
  saveIdempotentResponse
};
