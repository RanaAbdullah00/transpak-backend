const { query } = require("../db/pool");

/**
 * Append-only operational audit log. Never throws to callers.
 * @param {{ actorUserId?: string|null, action: string, targetEntity: string, targetId?: string|null, metadata?: object }} entry
 */
async function writeAudit(entry) {
  const actorUserId = entry.actorUserId || null;
  const action = String(entry.action || "").trim().slice(0, 120);
  const targetEntity = String(entry.targetEntity || "").trim().slice(0, 64);
  const targetId = entry.targetId != null ? String(entry.targetId).slice(0, 128) : null;
  const metadata = entry.metadata && typeof entry.metadata === "object" ? entry.metadata : {};

  if (!action || !targetEntity) return;

  try {
    if (targetId) {
      const { rows: dup } = await query(
        `SELECT 1 FROM audit_events
         WHERE action = $1 AND target_entity = $2 AND target_id = $3
           AND actor_user_id IS NOT DISTINCT FROM $4::uuid
           AND created_at > now() - interval '60 seconds'
         LIMIT 1`,
        [action, targetEntity, targetId, actorUserId || null]
      );
      if (dup[0]) return;
    }
    await query(
      `INSERT INTO audit_events (actor_user_id, action, target_entity, target_id, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [actorUserId, action, targetEntity, targetId, JSON.stringify(metadata)]
    );
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn("[audit] write skipped:", err?.message || err);
    }
  }
}

function auditAfter(res, fn) {
  return (...args) => {
    const result = fn(...args);
    if (result && typeof result.then === "function") {
      return result.then((r) => {
        Promise.resolve().then(() => writeAudit(res)).catch(() => {});
        return r;
      });
    }
    Promise.resolve().then(() => writeAudit(res)).catch(() => {});
    return result;
  };
}

module.exports = { writeAudit, auditAfter };
