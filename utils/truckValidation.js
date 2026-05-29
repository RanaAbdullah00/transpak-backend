/** Pakistan-style plate: letters, digits, dashes — 3–15 chars after normalize. */
const PLATE_RE = /^[A-Za-z0-9][A-Za-z0-9\s-]{2,14}$/;

function validateLicensePlate(plate) {
  const p = String(plate || "").trim();
  if (!p || p.length < 3 || p.length > 20) {
    return { ok: false, message: "License plate must be 3–20 characters" };
  }
  if (!PLATE_RE.test(p)) {
    return { ok: false, message: "Invalid license plate format" };
  }
  return { ok: true, value: p };
}

function validateCapacity(capacity) {
  const n = Number(capacity);
  if (!Number.isFinite(n) || n < 0 || n > 80) {
    return { ok: false, message: "Capacity must be between 0 and 80 tons" };
  }
  return { ok: true, value: n };
}

function validateEngineNumber(engineNumber) {
  const e = String(engineNumber || "").trim();
  if (!e || e.length < 2 || e.length > 80) {
    return { ok: false, message: "Engine number must be 2–80 characters" };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9\s-]{1,79}$/.test(e)) {
    return { ok: false, message: "Invalid engine number format" };
  }
  return { ok: true, value: e };
}

module.exports = { validateLicensePlate, validateCapacity, validateEngineNumber };
