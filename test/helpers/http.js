const { getBaseUrl } = require("./config");

/** @type {Map<string, { token: string, user: object, email: string, expiresAt: number }>} */
const loginCache = new Map();
const LOGIN_CACHE_TTL_MS = Number(process.env.TEST_LOGIN_CACHE_TTL_MS || 15 * 60 * 1000);

function loginCacheKey(email, activeRole) {
  return `${String(email || "").toLowerCase()}::${String(activeRole || "").toLowerCase()}`;
}

function clearLoginCache() {
  loginCache.clear();
}

/**
 * @param {string} method
 * @param {string} urlPath - e.g. /api/auth/login
 * @param {{ token?: string, body?: object, query?: Record<string, string> }} [opts]
 */
async function api(method, urlPath, opts = {}) {
  const base = getBaseUrl();
  const url = new URL(urlPath.startsWith("/") ? urlPath : `/${urlPath}`, `${base}/`);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
  }
  const headers = { Accept: "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.workspace) headers["X-TransPak-Workspace"] = String(opts.workspace);
  if (opts.headers && typeof opts.headers === "object") {
    Object.assign(headers, opts.headers);
  }
  let body;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, { method: method.toUpperCase(), headers, body });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return {
    status: res.status,
    ok: res.ok,
    data,
    code: data?.code,
    message: data?.message,
    payload: data?.data
  };
}

/**
 * @param {string} email
 * @param {string} password
 * @param {'shipper'|'carrier'|'admin'} [activeRole]
 */
async function login(email, password, activeRole, opts = {}) {
  const key = loginCacheKey(email, activeRole);
  if (!opts.fresh) {
    const cached = loginCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return { token: cached.token, user: cached.user, email: cached.email };
    }
  }

  const res = await api("POST", "/api/auth/login", {
    body: { email, password, ...(activeRole ? { roleHint: activeRole } : {}) }
  });
  if (!res.ok || !res.payload?.token) {
    const err = new Error(res.message || `Login failed (${res.status}) for ${email}`);
    err.response = res;
    throw err;
  }
  let token = res.payload.token;
  let user = res.payload.user;
  const want = activeRole ? String(activeRole).toLowerCase() : "";
  if (want && user?.activeRole !== want) {
    const switched = await api("PATCH", "/api/auth/active-role", {
      token,
      body: { activeRole: want }
    });
    token = switched.payload?.token || token;
    user = switched.payload?.user || user;
  }
  const session = { token, user, email };
  loginCache.set(key, { ...session, expiresAt: Date.now() + LOGIN_CACHE_TTL_MS });
  return session;
}

function futurePickupDate(daysAhead = 3) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}

function defaultLoadBody(overrides = {}) {
  return {
    cargo: `Safety test load ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    origin: "Lahore",
    destination: "Karachi",
    weight: 12,
    vehicleType: "Truck",
    expectedPrice: 150000,
    pickupDate: futurePickupDate(3),
    deadlineMinutes: 360,
    ...overrides
  };
}

function decodeUserIdFromToken(token) {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) return null;
    const json = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return json.userId || json.sub || json.id || null;
  } catch {
    return null;
  }
}

async function createOpenLoad(shipperToken, overrides = {}, opts = {}) {
  let res = await api("POST", "/api/loads/create", {
    token: shipperToken,
    body: defaultLoadBody(overrides)
  });
  if (res.status === 403 && res.code === "PROFILE_INCOMPLETE") {
    const { hasDatabaseUrl } = require("./config");
    const { ensureUserProfileComplete } = require("./db");
    const userId = opts.shipperUserId || decodeUserIdFromToken(shipperToken);
    if (hasDatabaseUrl() && userId) {
      await ensureUserProfileComplete(userId);
      res = await api("POST", "/api/loads/create", {
        token: shipperToken,
        body: defaultLoadBody(overrides)
      });
    }
  }
  if (res.status === 403 && res.code === "PROFILE_INCOMPLETE") {
    const err = new Error("E2E shipper profile incomplete — complete profile in DB or use a ready test account");
    err.response = res;
    throw err;
  }
  if (!res.ok || !res.payload?.id) {
    const err = new Error(res.message || `Create load failed (${res.status})`);
    err.response = res;
    throw err;
  }
  return res.payload;
}

async function placeBid(carrierToken, loadId, amount = 140000) {
  const res = await placeBidRaw(carrierToken, loadId, amount);
  if (!res.ok || !res.payload?.id) {
    const err = new Error(res.message || `Place bid failed (${res.status})`);
    err.response = res;
    throw err;
  }
  return res.payload;
}

/** Raw bid POST — for concurrency / idempotency tests. */
async function placeBidRaw(carrierToken, loadId, amount = 140000, opts = {}) {
  return api("POST", "/api/bids", {
    token: carrierToken,
    body: { loadId, amount: Number(amount) },
    headers: opts.headers
  });
}

async function acceptBid(shipperToken, bidId) {
  return api("PUT", `/api/bids/${bidId}/accept`, { token: shipperToken });
}

async function healthCheck() {
  return api("GET", "/api/health");
}

module.exports = {
  api,
  login,
  clearLoginCache,
  futurePickupDate,
  defaultLoadBody,
  createOpenLoad,
  placeBid,
  placeBidRaw,
  acceptBid,
  healthCheck
};
