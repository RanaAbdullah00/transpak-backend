const { sendSuccess, sendError } = require("../../utils/apiResponse");
const loadRepo = require("../repositories/loadRepo");

async function listOpen(req, res) {
  try {
    const { origin, destination, vehicleType, city, minPrice, maxPrice } = req.query || {};
    const minRaw = minPrice !== undefined && String(minPrice).trim() !== "" ? String(minPrice).trim() : "";
    const maxRaw = maxPrice !== undefined && String(maxPrice).trim() !== "" ? String(maxPrice).trim() : "";
    if (minRaw && !Number.isFinite(Number(minRaw))) return sendError(res, 400, "minPrice must be a valid number");
    if (maxRaw && !Number.isFinite(Number(maxRaw))) return sendError(res, 400, "maxPrice must be a valid number");
    const minN = minRaw ? Number(minRaw) : null;
    const maxN = maxRaw ? Number(maxRaw) : null;
    if (minN != null && maxN != null && minN > maxN) return sendError(res, 400, "minPrice cannot exceed maxPrice");

    const loads = await loadRepo.listOpenLoads({ origin, destination, vehicleType, city, minPrice: minN, maxPrice: maxN });
    return sendSuccess(res, 200, loads);
  } catch (err) {
    return sendError(res, 500, err.message || "Server error");
  }
}

module.exports = { listOpen };

