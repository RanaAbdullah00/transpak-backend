const express = require("express");
const { getPolicyHealthSnapshot } = require("../utils/policyEngine");
const { getDriftReport } = require("../utils/runtimeIntegrityGuard");

const router = express.Router();

async function resolveLightDbStatus() {
  try {
    const { isDatabaseUrlConfigured, query } = require("../db/pool");
    if (!isDatabaseUrlConfigured()) {
      return { status: "not_configured", ok: false };
    }
    await query("SELECT 1 AS ok");
    return { status: "connected", ok: true };
  } catch (err) {
    return {
      status: "unavailable",
      ok: false,
      message: String(err?.message || "db_error").slice(0, 120)
    };
  }
}

/** Runtime policy + drift audit — never throws, always HTTP 200. */
router.get("/policy-health", async (req, res) => {
  try {
    const snapshot = getPolicyHealthSnapshot();
    const drift = getDriftReport();
    const db = await resolveLightDbStatus();
    const systemDrift = Boolean(drift.systemDrift);

    return res.status(200).json({
      success: true,
      message: systemDrift ? "drift_detected" : "ok",
      systemDrift,
      data: {
        ...snapshot,
        db
      }
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[policy-health] degraded response", err?.message || err);
    return res.status(200).json({
      success: true,
      message: "degraded",
      systemDrift: true,
      data: {
        commit: "unknown",
        commitShort: "unknown",
        policyEngineVersion: "unknown",
        vehicleMatchMode: "STRICT",
        safeMode: true,
        runtimeDrift: { inSync: false, systemDrift: true, driftCount: 1, drifts: [] },
        db: { status: "unknown", ok: false }
      }
    });
  }
});

module.exports = router;
