/**
 * Phase 6 — monotonic sequenceId (Redis INCR primary, DB fallback).
 */
const { query } = require("../db/pool");
const { getRedisClient } = require("./redisClient");

async function nextSequenceId(name = "tracking") {
  const label = String(name || "tracking").slice(0, 64);
  const redis = getRedisClient();
  if (redis.isEnabled()) {
    try {
      return await redis.incr(`seq:${label}`);
    } catch {
      /* fall through to DB */
    }
  }

  try {
    const { rows } = await query(
      `INSERT INTO global_sequences (name, last_value)
       VALUES ($1, 1)
       ON CONFLICT (name)
       DO UPDATE SET last_value = global_sequences.last_value + 1
       RETURNING last_value AS "lastValue"`,
      [label]
    );
    return Number(rows[0]?.lastValue || 1);
  } catch {
    return Date.now();
  }
}

module.exports = { nextSequenceId };
