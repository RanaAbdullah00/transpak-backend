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
