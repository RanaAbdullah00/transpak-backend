const cities = require("../data/pakistanCities.json");

function normalizeCityName(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function findCity(name) {
  const n = normalizeCityName(name);
  if (!n) return null;
  return cities.find((c) => normalizeCityName(c.name) === n) || null;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function distanceBetweenCities(origin, destination) {
  const o = findCity(origin);
  const d = findCity(destination);
  if (!o || !d) return null;
  const km = haversineKm(o.lat, o.lng, d.lat, d.lng);
  return Math.round(km * 100) / 100;
}

module.exports = { findCity, haversineKm, distanceBetweenCities, normalizeCityName };
