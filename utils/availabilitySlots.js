/**
 * Normalize and validate carrier space availability slots.
 * Shape: [{ start: "08:00", end: "12:00" }, ...]
 */

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseMinutes(hhmm) {
  const m = TIME_RE.exec(String(hhmm || "").trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function normalizeAvailabilitySlots(raw) {
  if (raw == null) return null;
  if (!Array.isArray(raw)) return null;
  const slots = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const start = String(item.start || "").trim();
    const end = String(item.end || "").trim();
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) continue;
    const startMin = parseMinutes(start);
    const endMin = parseMinutes(end);
    if (startMin == null || endMin == null || endMin <= startMin) continue;
    slots.push({ start, end });
  }
  return slots.length ? slots : null;
}

function validateAvailabilitySlots(raw) {
  if (raw == null || raw === undefined) return { ok: true, value: null };
  if (!Array.isArray(raw)) {
    return { ok: false, message: "availabilitySlots must be an array" };
  }
  const normalized = normalizeAvailabilitySlots(raw);
  if (raw.length > 0 && !normalized) {
    return { ok: false, message: "Invalid availability time slots" };
  }
  if (normalized && normalized.length > 12) {
    return { ok: false, message: "Too many availability slots (max 12)" };
  }
  return { ok: true, value: normalized };
}

module.exports = {
  normalizeAvailabilitySlots,
  validateAvailabilitySlots
};
