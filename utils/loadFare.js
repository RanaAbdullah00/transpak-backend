const { distanceBetweenCities } = require("./geoDistance");

function trimLoc(s) {
  return String(s || "").trim();
}

const VEHICLE_MULTIPLIER = {
  truck: 1,
  trailer: 1.15,
  container: 1.25,
  flatbed: 1.08
};

function vehicleMultiplier(vehicleType) {
  const key = String(vehicleType || "truck").toLowerCase();
  return VEHICLE_MULTIPLIER[key] || 1;
}

function estimateDistanceKm(origin, destination, clientDistance) {
  const client = Number(clientDistance);
  if (Number.isFinite(client) && client > 0) return Math.round(client * 100) / 100;
  const o = trimLoc(origin);
  const d = trimLoc(destination);
  if (o && d && o.toLowerCase() === d.toLowerCase()) return 1;
  const geo = distanceBetweenCities(o, d);
  if (geo != null && geo > 0) return geo;
  const fallback = Number(process.env.LOAD_DEFAULT_DISTANCE_KM || 50);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 50;
}

function calculateSuggestedFare(distanceKm, vehicleType = "Truck") {
  const km = Number(distanceKm) || 0;
  const litersPer50 = Number(process.env.FUEL_LITERS_PER_50KM || 8);
  const pricePerLiter = Number(process.env.FUEL_PRICE_PER_LITER || 280);
  const legacyPerKm = Number(process.env.FUEL_PRICE_PER_KM || process.env.FUEL_PRICE_PER_KM_FACTOR || 0);
  const mult = vehicleMultiplier(vehicleType);

  if (legacyPerKm > 0) {
    return Math.round(km * legacyPerKm * mult * 100) / 100;
  }

  const segments = km / 50;
  const fuelCost = segments * litersPer50 * pricePerLiter * mult;
  return Math.round(fuelCost * 100) / 100;
}

module.exports = { estimateDistanceKm, calculateSuggestedFare, vehicleMultiplier };
