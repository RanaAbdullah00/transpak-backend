/**
 * Phase 7 — strict distributed mode detection.
 */

function isTruthyEnv(name) {
  return String(process.env[name] || "").trim().toLowerCase() === "true";
}

function isStrictDistributedEnabled() {
  return isTruthyEnv("ENABLE_STRICT_DISTRIBUTED");
}

function isMultiInstanceDeployment() {
  if (String(process.env.DISTRIBUTED_MODE || "").trim().toLowerCase() === "multi") {
    return true;
  }
  if (isTruthyEnv("RENDER")) return true;
  if (String(process.env.RENDER_INSTANCE_ID || "").trim()) return true;
  if (String(process.env.INSTANCE_ID || "").trim()) return true;
  return false;
}

function requiresRedis() {
  return isStrictDistributedEnabled() && isMultiInstanceDeployment();
}

function getDistributedModeSummary() {
  return {
    strict: isStrictDistributedEnabled(),
    multiInstance: isMultiInstanceDeployment(),
    requiresRedis: requiresRedis()
  };
}

module.exports = {
  isStrictDistributedEnabled,
  isMultiInstanceDeployment,
  requiresRedis,
  getDistributedModeSummary
};
