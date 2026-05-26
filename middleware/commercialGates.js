const userRepo = require("../repositories/userRepo");
const { query } = require("../db/pool");
const { sendError } = require("../utils/apiResponse");

async function loadUser(req) {
  if (req._commercialUser) return req._commercialUser;
  const user = await userRepo.findById(req.auth.userId);
  req._commercialUser = user;
  return user;
}

async function requireShipperProfileComplete(req, res, next) {
  try {
    const user = await loadUser(req);
    if (!user) return sendError(res, 401, "Unauthorized");
    if (!user.isProfileComplete) {
      return sendError(res, 403, "Complete your profile to post loads", null, "PROFILE_INCOMPLETE");
    }
    return next();
  } catch (err) {
    return sendError(res, 500, err.message || "Server error");
  }
}

async function requireCarrierProfileComplete(req, res, next) {
  try {
    const user = await loadUser(req);
    if (!user) return sendError(res, 401, "Unauthorized");
    if (!user.isProfileComplete) {
      return sendError(res, 403, "Complete your carrier profile first", null, "PROFILE_INCOMPLETE");
    }
    return next();
  } catch (err) {
    return sendError(res, 500, err.message || "Server error");
  }
}

async function requireCarrierTruckReady(req, res, next) {
  try {
    const user = await loadUser(req);
    if (!user) return sendError(res, 401, "Unauthorized");
    if (!user.isProfileComplete) {
      return sendError(res, 403, "Complete your carrier profile first", null, "PROFILE_INCOMPLETE");
    }
    const { rows } = await query(
      `SELECT id FROM trucks
       WHERE user_id = $1
         AND char_length(trim(coalesce(truck_card_front_image, ''))) > 0
         AND char_length(trim(coalesce(truck_card_back_image, ''))) > 0
       LIMIT 1`,
      [req.auth.userId]
    );
    if (!rows[0]) {
      return sendError(res, 403, "Add and complete at least one truck before bidding", null, "TRUCK_REQUIRED");
    }
    return next();
  } catch (err) {
    return sendError(res, 500, err.message || "Server error");
  }
}

module.exports = {
  requireShipperProfileComplete,
  requireCarrierProfileComplete,
  requireCarrierTruckReady
};
