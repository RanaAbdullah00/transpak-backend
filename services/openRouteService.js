const axios = require("axios");
const { findCity, haversineKm } = require("../utils/geoDistance");
const { normalizeRoutePayload } = require("../utils/routeResponse");

const CACHE_MS = Number(process.env.ORS_CACHE_MS || 900000);
const TIMEOUT_MS = Number(process.env.ORS_TIMEOUT_MS || 12000);
const ORS_BASE = "https://api.openrouteservice.org/v2/directions/driving-car/geojson";

/** @type {Map<string, { t: number, data: object }>} */
const routeCache = new Map();

function getApiKey() {
  return String(process.env.ORS_API_KEY || "").trim() || null;
}

function straightLine(start, end) {
  return [
    [start.lat, start.lng],
    [end.lat, end.lng]
  ];
}

function cacheKeyForPair(start, end) {
  return `${start.lat.toFixed(4)},${start.lng.toFixed(4)}|${end.lat.toFixed(4)},${end.lng.toFixed(4)}`;
}

function roundKm(km) {
  return Math.round(Number(km) * 100) / 100;
}

function isRetryableError(err) {
  const code = err?.code;
  if (code === "ECONNABORTED" || code === "ETIMEDOUT" || code === "ENOTFOUND") return true;
  const status = err?.response?.status;
  return status === 429 || (status >= 500 && status < 600);
}

function haversineFallback(start, end, code, message) {
  return normalizeRoutePayload({
    ok: true,
    fallback: true,
    source: "haversine",
    coordinates: straightLine(start, end),
    distanceKm: roundKm(haversineKm(start.lat, start.lng, end.lat, end.lng)),
    durationSeconds: null,
    code: code || "ORS_ROUTE_FAILED",
    message
  });
}

async function callOrsOnce(start, end, apiKey) {
  const res = await axios.post(
    ORS_BASE,
    {
      coordinates: [
        [start.lng, start.lat],
        [end.lng, end.lat]
      ]
    },
    {
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json"
      },
      timeout: TIMEOUT_MS
    }
  );

  const feature = res.data?.features?.[0];
  const raw = feature?.geometry?.coordinates;
  if (!Array.isArray(raw) || raw.length < 2) {
    throw new Error("ORS returned empty geometry");
  }

  const coordinates = raw.map((pair) => [Number(pair[1]), Number(pair[0])]);
  const summary = feature?.properties?.summary || {};
  const distanceKm =
    summary.distance != null ? roundKm(Number(summary.distance) / 1000) : null;
  const durationSeconds =
    summary.duration != null ? Math.round(Number(summary.duration)) : null;

  return normalizeRoutePayload({
    fallback: false,
    source: "openrouteservice",
    coordinates,
    distanceKm,
    durationSeconds
  });
}

/**
 * @param {{ lat: number, lng: number }} start
 * @param {{ lat: number, lng: number }} end
 */
async function fetchDrivingRoute(start, end) {
  const apiKey = getApiKey();
  if (!apiKey) {
    return haversineFallback(start, end, "ORS_NOT_CONFIGURED", "ORS_API_KEY not set");
  }

  const ck = cacheKeyForPair(start, end);
  const cached = routeCache.get(ck);
  if (cached && Date.now() - cached.t < CACHE_MS) {
    return cached.data;
  }

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const data = await callOrsOnce(start, end, apiKey);
      if (!data.fallback) {
        routeCache.set(ck, { t: Date.now(), data });
      }
      return data;
    } catch (err) {
      lastErr = err;
      if (attempt === 0 && isRetryableError(err)) {
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      break;
    }
  }

  const status = lastErr?.response?.status;
  const msg =
    lastErr?.response?.data?.error?.message ||
    lastErr?.response?.data?.message ||
    lastErr?.message ||
    "Route request failed";
  // eslint-disable-next-line no-console
  console.warn("[ors] route failed", {
    status: status || null,
    message: msg,
    from: `${start.lat},${start.lng}`,
    to: `${end.lat},${end.lng}`
  });
  return haversineFallback(start, end, "ORS_ROUTE_FAILED", msg);
}

async function routeBetweenCities(origin, destination) {
  const o = findCity(origin);
  const d = findCity(destination);
  if (!o || !d) {
    return { ok: false, code: "CITY_NOT_FOUND", message: "Unknown origin or destination city" };
  }
  const data = await fetchDrivingRoute({ lat: o.lat, lng: o.lng }, { lat: d.lat, lng: d.lng });
  return { ok: true, ...data };
}

async function routeBetweenPoints(points) {
  if (!Array.isArray(points) || points.length < 2) {
    return { ok: false, code: "INVALID_COORDS", message: "At least two coordinates required" };
  }
  const normalized = points.map((p) => {
    if (Array.isArray(p)) return { lat: Number(p[0]), lng: Number(p[1]) };
    return { lat: Number(p.lat), lng: Number(p.lng) };
  });
  if (normalized.some((p) => !Number.isFinite(p.lat) || !Number.isFinite(p.lng))) {
    return { ok: false, code: "INVALID_COORDS", message: "Invalid coordinate values" };
  }
  if (normalized.length === 2) {
    const data = await fetchDrivingRoute(normalized[0], normalized[1]);
    return { ok: true, ...data };
  }
  const data = normalizeRoutePayload({
    fallback: true,
    source: "polyline",
    coordinates: normalized.map((p) => [p.lat, p.lng]),
    distanceKm: null,
    durationSeconds: null
  });
  return { ok: true, ...data };
}

module.exports = {
  fetchDrivingRoute,
  routeBetweenCities,
  routeBetweenPoints,
  getApiKey
};
