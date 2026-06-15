/**
 * Short-TTL in-memory cache for admin dashboard widget fetches.
 */
const TTL_MS = Number(process.env.ADMIN_DASHBOARD_CACHE_MS || 8000);

const store = new Map();

function cacheKey(widget) {
  return `widget:${String(widget || "").trim().toLowerCase()}`;
}

function getCachedWidget(widget) {
  const key = cacheKey(widget);
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > TTL_MS) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

function setCachedWidget(widget, value) {
  const key = cacheKey(widget);
  store.set(key, { at: Date.now(), value });
}

function invalidateAdminDashboardCache(widget = null) {
  if (!widget) {
    store.clear();
    return;
  }
  store.delete(cacheKey(widget));
}

module.exports = {
  TTL_MS,
  getCachedWidget,
  setCachedWidget,
  invalidateAdminDashboardCache
};
