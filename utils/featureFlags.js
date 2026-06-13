/**
 * Production feature flags — env-driven, no demo hardcoding.
 * ALL business modules must read flags through this file (never process.env directly).
 */

const KNOWN_TRUTHY = new Set(["true", "1", "yes"]);
const KNOWN_FALSY = new Set(["false", "0", "no", ""]);

function truthy(v) {
  const s = String(v || "").trim().toLowerCase();
  return KNOWN_TRUTHY.has(s);
}

function isKnownFlagValue(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return KNOWN_TRUTHY.has(s) || KNOWN_FALSY.has(s);
}

/** When true, VEHICLE_TYPE_MISMATCH is logged and returned as a warning — bid is not blocked. */
function isVehicleTypeMismatchRelaxed() {
  const raw = process.env.ALLOW_VEHICLE_TYPE_MISMATCH;
  if (raw == null || String(raw).trim() === "") {
    return false;
  }
  if (!isKnownFlagValue(raw)) {
    return false;
  }
  return truthy(raw);
}

/**
 * Single vehicle-match policy for listing SQL + bid validation.
 * Missing/invalid flag → STRICT (safe default).
 * @returns {{ relaxed: boolean, strictFilter: boolean }}
 */
function getVehicleMatchPolicy() {
  const relaxed = isVehicleTypeMismatchRelaxed();
  return {
    relaxed,
    strictFilter: !relaxed
  };
}

/** Validate configured flags — invalid values fall back to STRICT at runtime. */
function validateFeatureFlags() {
  const issues = [];
  const raw = process.env.ALLOW_VEHICLE_TYPE_MISMATCH;
  if (raw != null && String(raw).trim() !== "" && !isKnownFlagValue(raw)) {
    issues.push({
      flag: "ALLOW_VEHICLE_TYPE_MISMATCH",
      reason: "invalid_value",
      value: String(raw).slice(0, 64),
      fallback: "STRICT"
    });
  }
  return {
    ok: issues.length === 0,
    issues,
    effective: getPublicFeatureFlags()
  };
}

/** Health / ops snapshot — safe to expose publicly. */
function getPublicFeatureFlags() {
  const policy = getVehicleMatchPolicy();
  return {
    allowVehicleTypeMismatch: policy.relaxed
  };
}

function isExampleUploadEnabled() {
  return truthy(process.env.ENABLE_EXAMPLE_UPLOAD);
}

module.exports = {
  truthy,
  isKnownFlagValue,
  isVehicleTypeMismatchRelaxed,
  getVehicleMatchPolicy,
  validateFeatureFlags,
  getPublicFeatureFlags,
  isExampleUploadEnabled
};
