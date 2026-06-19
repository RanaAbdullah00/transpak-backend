const { getBaseUrl } = require("./config");

// Health includes DB/schema probes; local dev often exceeds 5s.
const DEFAULT_TIMEOUT_MS = Number(process.env.INTEGRATION_HEALTH_TIMEOUT_MS || 20000);

/**
 * Probe /api/health on the configured QA base URL.
 * @param {string} [baseUrl]
 * @param {{ timeoutMs?: number }} [opts]
 */
async function isServerReachable(baseUrl = getBaseUrl(), opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${String(baseUrl).replace(/\/$/, "")}/api/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    return data?.success === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Wait until health responds or timeout. */
async function waitForServer(baseUrl = getBaseUrl(), { timeoutMs = 30000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isServerReachable(baseUrl)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/** True when API health reports integration rate-limit bypass (server env). */
async function serverHasIntegrationBypass(baseUrl = getBaseUrl(), opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${String(baseUrl).replace(/\/$/, "")}/api/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    const data = await res.json().catch(() => null);
    return Boolean(data?.data?.integrationTestBypass);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { isServerReachable, waitForServer, serverHasIntegrationBypass };
