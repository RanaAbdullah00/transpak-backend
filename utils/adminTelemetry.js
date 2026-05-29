/**
 * Admin dashboard telemetry — structured logs only (no PII / secrets).
 */

const SLOW_MS = Number(process.env.ADMIN_TELEMETRY_SLOW_MS || 1000);
const ring = [];
const RING_MAX = 200;

function redactMeta(meta) {
  if (!meta || typeof meta !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    const key = String(k).toLowerCase();
    if (
      key.includes("email") ||
      key.includes("password") ||
      key.includes("token") ||
      key.includes("cnic") ||
      key.includes("phone")
    ) {
      continue;
    }
    if (typeof v === "string" && v.length > 120) {
      out[k] = `${v.slice(0, 40)}…`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function recordAdminTelemetry(entry) {
  const row = {
    ts: new Date().toISOString(),
    widget: entry.widget ? String(entry.widget) : "unknown",
    event: String(entry.event || "unknown").slice(0, 64),
    durationMs: Number(entry.durationMs) || 0,
    ok: Boolean(entry.ok),
    statusCode: entry.statusCode != null ? Number(entry.statusCode) : null,
    code: entry.code != null ? String(entry.code).slice(0, 48) : null,
    attempt: entry.attempt != null ? Number(entry.attempt) : null,
    slow: Number(entry.durationMs) >= SLOW_MS,
    ...redactMeta(entry.meta)
  };

  ring.push(row);
  if (ring.length > RING_MAX) ring.shift();

  if (row.event === "auth_failure" || !row.ok) {
    // eslint-disable-next-line no-console
    console.warn("[admin-telemetry]", JSON.stringify(row));
  } else if (row.slow) {
    // eslint-disable-next-line no-console
    console.warn("[admin-telemetry]", JSON.stringify(row));
  } else if (process.env.NODE_ENV !== "production") {
    // eslint-disable-next-line no-console
    console.info("[admin-telemetry]", JSON.stringify(row));
  }
}

function getAdminTelemetrySnapshot(limit = 50) {
  return ring.slice(-Math.min(limit, RING_MAX));
}

module.exports = { recordAdminTelemetry, getAdminTelemetrySnapshot, SLOW_MS };
