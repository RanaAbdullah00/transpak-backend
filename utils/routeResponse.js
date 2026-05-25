/**
 * Normalized map route payload (API + internal services).
 * @param {object} raw
 */
function normalizeRoutePayload(raw) {
  const coordinates = Array.isArray(raw?.coordinates)
    ? raw.coordinates
        .map((p) => {
          if (Array.isArray(p) && p.length >= 2) return [Number(p[0]), Number(p[1])];
          if (p && p.lat != null && p.lng != null) return [Number(p.lat), Number(p.lng)];
          return null;
        })
        .filter(
          (p) =>
            p &&
            Number.isFinite(p[0]) &&
            Number.isFinite(p[1]) &&
            p[0] >= -90 &&
            p[0] <= 90 &&
            p[1] >= -180 &&
            p[1] <= 180
        )
    : [];

  const distanceKm =
    raw?.distanceKm != null && Number.isFinite(Number(raw.distanceKm))
      ? Math.round(Number(raw.distanceKm) * 100) / 100
      : null;

  const durationSeconds =
    raw?.durationSeconds != null && Number.isFinite(Number(raw.durationSeconds))
      ? Math.round(Number(raw.durationSeconds))
      : null;

  const source = String(raw?.source || "unknown").slice(0, 32);
  const fallback = Boolean(raw?.fallback);

  return {
    coordinates,
    distanceKm,
    durationSeconds,
    source,
    fallback
  };
}

module.exports = { normalizeRoutePayload };
