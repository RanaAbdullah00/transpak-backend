/**
 * Normalize and validate carrier space availability slots.
 * Supports HH:MM windows and visibility duration metadata objects.
 */

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseMinutes(hhmm) {
  const m = TIME_RE.exec(String(hhmm || "").trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function isVisibilityObject(item) {
  return item && typeof item === "object" && String(item.type || "").toLowerCase() === "visibility";
}

function normalizeVisibilityObject(item) {
  if (!isVisibilityObject(item)) return null;
  const durationMinutes = Number(item.durationMinutes);
  const visibleUntil = item.visibleUntil ? String(item.visibleUntil) : null;
  if (!Number.isFinite(durationMinutes) || durationMinutes < 15 || durationMinutes > 72 * 60) {
    return null;
  }
  if (!visibleUntil || Number.isNaN(new Date(visibleUntil).getTime())) {
    return null;
  }
  return {
    type: "visibility",
    durationMinutes: Math.floor(durationMinutes),
    visibleUntil
  };
}

function normalizeAvailabilitySlots(raw) {
  if (raw == null) return null;
  if (!Array.isArray(raw)) return null;
  const slots = [];
  for (const item of raw) {
    if (isVisibilityObject(item)) {
      const vis = normalizeVisibilityObject(item);
      if (vis) slots.push(vis);
      continue;
    }
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
    return { ok: false, message: "Invalid availability slots" };
  }
  if (normalized && normalized.length > 12) {
    return { ok: false, message: "Too many availability slots (max 12)" };
  }
  return { ok: true, value: normalized };
}

function buildVisibilitySlotFromDuration(durationMinutes) {
  const mins = Number(durationMinutes);
  const safe = Number.isFinite(mins) && mins >= 15 ? Math.min(Math.floor(mins), 72 * 60) : 360;
  const visibleUntil = new Date(Date.now() + safe * 60 * 1000).toISOString();
  return {
    type: "visibility",
    durationMinutes: safe,
    visibleUntil
  };
}

module.exports = {
  normalizeAvailabilitySlots,
  validateAvailabilitySlots,
  buildVisibilitySlotFromDuration,
  isVisibilityObject
};
