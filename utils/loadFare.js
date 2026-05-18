const { distanceBetweenCities } = require("./geoDistance");

function trimLoc(s) {
  return String(s || "").trim();
}

const VEHICLE_MULTIPLIER = {
  truck: 1,
  trailer: 1.15,
  container: 1.25,
  flatbed: 1.08,
  reefer: 1.35,
  tanker: 1.2,
  mazda: 0.55,
  pickup: 0.45,
  dumper: 1.1,
  "mini loader": 0.65,
  "10 wheeler": 1.05,
  "22 wheeler": 1.3
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

/**
 * Pakistan road-freight estimate:
 * fuelCost = distanceKm × litersPerKm × dieselRatePerLiter × vehicleMultiplier
 * recommended = fuelCost + platformMargin (fixed PKR + % of fuel)
 */
function calculateFareBreakdown(distanceKm, vehicleType = "Truck") {
  const km = Number(distanceKm) || 0;
  const litersPerKm = Number(process.env.FUEL_LITERS_PER_KM || 0.35);
  const dieselRate = Number(process.env.FUEL_PRICE_PER_LITER || 280);
  const marginPkR = Number(process.env.FARE_PLATFORM_MARGIN_PKR || 500);
  const marginPct = Number(process.env.FARE_PLATFORM_MARGIN_PERCENT || 10);
  const mult = vehicleMultiplier(vehicleType);

  const fuelCost = Math.round(km * litersPerKm * dieselRate * mult);
  const platformMargin = Math.round(marginPkR + (fuelCost * marginPct) / 100);
  const suggestedFare = Math.max(0, Math.round(fuelCost + platformMargin));

  return {
    distanceKm: km,
    fuelCost,
    platformMargin,
    suggestedFare,
    dieselRatePerLiter: dieselRate,
    litersPerKm,
    vehicleMultiplier: mult
  };
}

function calculateSuggestedFare(distanceKm, vehicleType = "Truck") {
  return calculateFareBreakdown(distanceKm, vehicleType).suggestedFare;
}

module.exports = {
  estimateDistanceKm,
  calculateSuggestedFare,
  calculateFareBreakdown,
  vehicleMultiplier
};
