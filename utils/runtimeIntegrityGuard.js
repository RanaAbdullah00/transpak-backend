/**
 * Lightweight runtime drift detection — never throws, never blocks boot.
 * Compares Render/deploy identity, policy versions, and feature-flag expectations.
 */
const { BUILD_COMMIT, BUILD_ID, normalizeCommit, readBuildStamp } = require("./deployIdentity");
const {
  getPublicFeatureFlags,
  validateFeatureFlags,
  truthy
} = require("./featureFlags");

const REPORT_CACHE_MS = 5000;
let cachedReport = null;
let cachedAt = 0;

function getRuntimePolicyEngineVersion() {
  try {
    return require("./policyEngine").POLICY_ENGINE_VERSION || "unknown";
  } catch {
    return "unknown";
  }
}

function buildDriftReport() {
  const drifts = [];

  try {
    const expectedCommit = String(process.env.EXPECTED_DEPLOY_COMMIT || "").trim();
    if (expectedCommit && normalizeCommit(expectedCommit) !== BUILD_ID) {
      drifts.push({
        type: "commit",
        expected: expectedCommit,
        actual: BUILD_COMMIT,
        actualShort: BUILD_ID
      });
    }

    const expectedPolicy = String(process.env.EXPECTED_POLICY_ENGINE_VERSION || "").trim();
    if (expectedPolicy) {
      const actualPolicy = getRuntimePolicyEngineVersion();
      if (expectedPolicy !== actualPolicy) {
        drifts.push({
          type: "policy_engine_version",
          expected: expectedPolicy,
          actual: actualPolicy
        });
      }
    }

    const expectedFlagRaw = process.env.EXPECTED_ALLOW_VEHICLE_TYPE_MISMATCH;
    if (expectedFlagRaw != null && String(expectedFlagRaw).trim() !== "") {
      const expectedBool = truthy(expectedFlagRaw);
      const actualBool = Boolean(getPublicFeatureFlags().allowVehicleTypeMismatch);
      if (expectedBool !== actualBool) {
        drifts.push({
          type: "feature_flag",
          flag: "ALLOW_VEHICLE_TYPE_MISMATCH",
          expected: expectedBool,
          actual: actualBool
        });
      }
    }

    const flagValidation = validateFeatureFlags();
    if (!flagValidation.ok) {
      for (const issue of flagValidation.issues) {
        drifts.push({ type: "flag_validation", ...issue });
      }
    }

    const renderCommit = String(process.env.RENDER_GIT_COMMIT || "").trim();
    const stamp = readBuildStamp();
    if (
      renderCommit &&
      stamp?.commitFull &&
      normalizeCommit(renderCommit) !== normalizeCommit(stamp.commitFull)
    ) {
      drifts.push({
        type: "build_stamp",
        expected: renderCommit,
        actual: stamp.commitFull
      });
    }
  } catch (err) {
    drifts.push({
      type: "integrity_guard_error",
      message: err?.message || String(err)
    });
  }

  const systemDrift = drifts.length > 0;
  if (systemDrift) {
    // eslint-disable-next-line no-console
    console.warn("[integrity] system drift detected", { count: drifts.length, drifts });
  }

  return {
    inSync: !systemDrift,
    systemDrift,
    drifts,
    runtimeCommit: BUILD_COMMIT,
    runtimeCommitShort: BUILD_ID,
    policyEngineVersion: getRuntimePolicyEngineVersion(),
    featureFlags: getPublicFeatureFlags(),
    checkedAt: new Date().toISOString()
  };
}

function getDriftReport() {
  const now = Date.now();
  if (cachedReport && now - cachedAt < REPORT_CACHE_MS) {
    return cachedReport;
  }
  cachedReport = buildDriftReport();
  cachedAt = now;
  return cachedReport;
}

function isSystemInSync() {
  return getDriftReport().inSync;
}

function invalidateDriftCache() {
  cachedReport = null;
  cachedAt = 0;
}

module.exports = {
  isSystemInSync,
  getDriftReport,
  invalidateDriftCache
};
