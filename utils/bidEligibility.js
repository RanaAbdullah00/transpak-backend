const { getCarrierFleetProfile } = require("./loadMatching");
const { fleetMatchesLoad, normalizeVehicleType } = require("./matchingEngine");

const normalizeType = normalizeVehicleType;

/**
 * Validates carrier can bid on load (vehicle type + capacity + active fleet).
 * @returns {{ ok: true } | { ok: false, status: number, message: string, code: string }}
 */
async function validateCarrierBidEligibility(carrierUserId, load) {
  const fleet = await getCarrierFleetProfile(carrierUserId);
  return fleetMatchesLoad(fleet, load);
}

module.exports = { validateCarrierBidEligibility, normalizeType };
