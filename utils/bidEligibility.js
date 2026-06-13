/**
 * @deprecated Use matchingEngine.validateBidPlacement / fleetMatchesLoad directly.
 * Kept for backward compatibility — thin re-export only.
 */
const { getCarrierFleetProfile } = require("./loadMatching");
const { fleetMatchesLoad, normalizeVehicleType } = require("./matchingEngine");

const normalizeType = normalizeVehicleType;

async function validateCarrierBidEligibility(carrierUserId, load) {
  const fleet = await getCarrierFleetProfile(carrierUserId);
  return fleetMatchesLoad(fleet, load);
}

module.exports = { validateCarrierBidEligibility, normalizeType };
