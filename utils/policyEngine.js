/**
 * Single source of truth for marketplace + auth policy (vehicle match, RBAC login, notify guard version).
 * Env reads stay in featureFlags; all rule decisions flow through this module.
 * When runtime drift is detected, SAFE MODE enforces STRICT vehicle matching.
 */
const { getVehicleMatchPolicy, getPublicFeatureFlags } = require("./featureFlags");
const { isAdminAccount, commercialRoles } = require("./authSessionPolicy");
const { NOTIFICATION_GUARD_VERSION } = require("./roleNotifyGuard");
const { BUILD_COMMIT, BUILD_ID } = require("./deployIdentity");

const POLICY_ENGINE_VERSION = "1.0.0";
const ROLE_ENFORCEMENT_VERSION = "1.0.0";

let safeModeLogged = false;

function normalizeVehicleType(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function isSafeModeActive() {
  try {
    const { getDriftReport } = require("./runtimeIntegrityGuard");
    const drift = getDriftReport();
    if (drift.systemDrift && !safeModeLogged) {
      safeModeLogged = true;
      // eslint-disable-next-line no-console
      console.warn("[policy] SAFE MODE active — drift detected, enforcing STRICT vehicle matching", {
        drifts: drift.drifts?.length || 0
      });
    }
    return Boolean(drift.systemDrift);
  } catch (err) {
    if (!safeModeLogged) {
      safeModeLogged = true;
      // eslint-disable-next-line no-console
      console.warn("[policy] SAFE MODE active — integrity guard unavailable", err?.message || err);
    }
    return true;
  }
}

/** Effective policy after SAFE MODE override (drift → always STRICT). */
function getEffectiveVehicleMatchPolicy() {
  if (isSafeModeActive()) {
    return { relaxed: false, strictFilter: true, safeMode: true };
  }
  return { ...getVehicleMatchPolicy(), safeMode: false };
}

function getVehicleMatchMode() {
  return getEffectiveVehicleMatchPolicy().relaxed ? "RELAXED" : "STRICT";
}

/** True when open-load listing should SQL-filter by carrier fleet vehicle types. */
function shouldFilterLoadsByVehicle() {
  return getEffectiveVehicleMatchPolicy().strictFilter;
}

/**
 * Core fleet vs load vehicle + capacity rules (shared by listing visibility and bid placement).
 * @param {{ truckTypes: string[], maxCapacityTons: number, truckCount?: number }} fleet
 * @param {object} load
 * @param {{ requireFleet?: boolean, forListing?: boolean }} [opts]
 */
function evaluateFleetPolicy(fleet, load, opts = {}) {
  const { requireFleet = false, forListing = false } = opts;

  if (requireFleet && !fleet?.truckCount) {
    return {
      ok: false,
      status: 403,
      message: "Add at least one active truck to your fleet",
      code: "FLEET_REQUIRED"
    };
  }

  const requiredType = normalizeVehicleType(load?.vehicle_type ?? load?.vehicleType);
  const types = (fleet?.truckTypes || []).map(normalizeVehicleType).filter(Boolean);
  const vehicleMismatch =
    requiredType && types.length > 0 && !types.includes(requiredType);

  if (vehicleMismatch) {
    if (shouldFilterLoadsByVehicle()) {
      return {
        ok: false,
        status: 409,
        message: "Your fleet has no truck matching this load vehicle type",
        code: "VEHICLE_TYPE_MISMATCH"
      };
    }
    if (forListing) {
      return { ok: true };
    }
    // eslint-disable-next-line no-console
    console.warn("[policy] VEHICLE_TYPE_MISMATCH relaxed — bid allowed", {
      requiredType,
      fleetTypes: types
    });
    return {
      ok: true,
      vehicleTypeMismatchWarning: true,
      warningCode: "VEHICLE_TYPE_MISMATCH"
    };
  }

  const loadWeight = Number(load?.weight ?? 0);
  const maxCap = Number(fleet?.maxCapacityTons ?? 0);
  if (loadWeight > 0 && maxCap > 0 && loadWeight > maxCap) {
    return {
      ok: false,
      status: 409,
      message: `Load weight exceeds your fleet capacity (${maxCap} tons max)`,
      code: "CAPACITY_EXCEEDED"
    };
  }

  return { ok: true };
}

/** Carrier load-board visibility (listing SQL + post-filter semantics). */
function shouldAllowLoad(fleet, load) {
  return evaluateFleetPolicy(fleet, load, { requireFleet: false, forListing: true });
}

/** Bid placement fleet eligibility (strict block vs relaxed warning). */
function shouldAllowBid(fleet, load) {
  return evaluateFleetPolicy(fleet, load, { requireFleet: true, forListing: false });
}

/**
 * Login role-hint validation — mirrors authController rules.
 * @returns {{ ok: true } | { ok: false, status: number, message: string, code: string }}
 */
function validateLoginRoleHint(authUser, roleHint) {
  if (isAdminAccount(authUser)) {
    return { ok: true };
  }

  const hint = String(roleHint || "").trim().toLowerCase();
  const commercial = commercialRoles(authUser);

  if (hint && !["shipper", "carrier"].includes(hint)) {
    return { ok: false, status: 400, message: "Invalid role", code: "INVALID_ROLE" };
  }
  if (commercial.length > 1 && !hint) {
    return {
      ok: false,
      status: 403,
      message: "Select shipper or carrier to continue",
      code: "ROLE_SELECTION_REQUIRED"
    };
  }
  if (hint && !commercial.includes(hint)) {
    return {
      ok: false,
      status: 403,
      message: "Invalid account type for selected role",
      code: "WRONG_ROLE"
    };
  }

  return { ok: true };
}

function getPolicyHealthSnapshot() {
  let driftReport = { inSync: true, systemDrift: false, drifts: [] };
  try {
    const { getDriftReport } = require("./runtimeIntegrityGuard");
    driftReport = getDriftReport();
  } catch {
    driftReport = { inSync: false, systemDrift: true, drifts: [{ type: "integrity_guard_error" }] };
  }

  const effective = getEffectiveVehicleMatchPolicy();
  return {
    commit: BUILD_COMMIT,
    commitShort: BUILD_ID,
    commitFull: BUILD_COMMIT,
    policyEngineVersion: POLICY_ENGINE_VERSION,
    featureFlags: getPublicFeatureFlags(),
    effectiveFeatureFlags: {
      allowVehicleTypeMismatch: effective.relaxed
    },
    vehicleMatchMode: getVehicleMatchMode(),
    vehicleMatchPolicy: effective,
    safeMode: Boolean(effective.safeMode),
    roleEnforcementVersion: ROLE_ENFORCEMENT_VERSION,
    notificationGuardVersion: NOTIFICATION_GUARD_VERSION,
    runtimeDrift: {
      inSync: driftReport.inSync,
      systemDrift: driftReport.systemDrift,
      driftCount: Array.isArray(driftReport.drifts) ? driftReport.drifts.length : 0,
      drifts: driftReport.drifts || []
    }
  };
}

const policyEngine = {
  version: POLICY_ENGINE_VERSION,
  POLICY_ENGINE_VERSION,
  ROLE_ENFORCEMENT_VERSION,
  normalizeVehicleType,
  getVehicleMatchMode,
  isSafeModeActive,
  getEffectiveVehicleMatchPolicy,
  shouldFilterLoadsByVehicle,
  shouldAllowLoad,
  shouldAllowBid,
  validateLoginRoleHint,
  getPolicyHealthSnapshot,
  getPublicFeatureFlags
};

module.exports = policyEngine;
