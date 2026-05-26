const { getBaseUrl } = require("./config");

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
async function login(email, password, activeRole) {
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
  return { token, user, email };
}

function futurePickupDate(daysAhead = 3) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}

function defaultLoadBody(overrides = {}) {
  return {
    cargo: `Safety test load ${Date.now()}`,
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

async function createOpenLoad(shipperToken, overrides = {}) {
  const res = await api("POST", "/api/loads/create", {
    token: shipperToken,
    body: defaultLoadBody(overrides)
  });
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
  const res = await api("POST", "/api/bids", {
    token: carrierToken,
    body: { loadId, amount }
  });
  if (!res.ok || !res.payload?.id) {
    const err = new Error(res.message || `Place bid failed (${res.status})`);
    err.response = res;
    throw err;
  }
  return res.payload;
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
  futurePickupDate,
  defaultLoadBody,
  createOpenLoad,
  placeBid,
  acceptBid,
  healthCheck
};
