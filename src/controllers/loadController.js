const { sendSuccess, sendError } = require("../../utils/apiResponse");
const loadRepo = require("../repositories/loadRepo");
const { runMarketplaceExpiryProcessor } = require("../../utils/loadExpiry");

async function listOpen(req, res) {
  try {
    await runMarketplaceExpiryProcessor();
    const q = req.query || {};
    const minRaw = q.minPrice !== undefined && String(q.minPrice).trim() !== "" ? String(q.minPrice).trim() : "";
    const maxRaw = q.maxPrice !== undefined && String(q.maxPrice).trim() !== "" ? String(q.maxPrice).trim() : "";
    if (minRaw && !Number.isFinite(Number(minRaw))) return sendError(res, 400, "minPrice must be a valid number");
    if (maxRaw && !Number.isFinite(Number(maxRaw))) return sendError(res, 400, "maxPrice must be a valid number");
    const minN = minRaw ? Number(minRaw) : null;
    const maxN = maxRaw ? Number(maxRaw) : null;
    if (minN != null && maxN != null && minN > maxN) return sendError(res, 400, "minPrice cannot exceed maxPrice");

    // All open loads visible on freight board — fleet matching enforced at bid time only.
    const result = await loadRepo.listOpenLoads({
      origin: q.origin,
      destination: q.destination,
      vehicleType: q.vehicleType,
      city: q.city,
      minPrice: minN,
      maxPrice: maxN,
      minWeight: q.minWeight,
      maxWeight: q.maxWeight,
      pickupFrom: q.pickupFrom,
      pickupTo: q.pickupTo,
      sort: q.sort || "newest",
      limit: q.limit,
      offset: q.offset,
      excludeCarrierId: req.auth?.userId
    });
    return sendSuccess(res, 200, result);
  } catch (err) {
    return sendError(res, 500, err.message || "Server error");
  }
}

module.exports = { listOpen };
