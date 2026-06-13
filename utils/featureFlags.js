/**
 * Production feature flags — env-driven, no demo hardcoding.
 */

function truthy(v) {
  const s = String(v || "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

/** When true, VEHICLE_TYPE_MISMATCH is logged and returned as a warning — bid is not blocked. */
function isVehicleTypeMismatchRelaxed() {
  return truthy(process.env.ALLOW_VEHICLE_TYPE_MISMATCH);
}

module.exports = {
  truthy,
  isVehicleTypeMismatchRelaxed
};
