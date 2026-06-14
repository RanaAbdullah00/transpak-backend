const express = require("express");
const { protect, requireAnyRole } = require("../middleware/authMiddleware");
const { sendSuccess, sendError } = require("../utils/apiResponse");
const {
  getMetricsSnapshot,
  ingestClientMetrics,
  toPrometheusLines
} = require("../utils/metricsCollector");

const router = express.Router();

router.get(
  "/",
  protect,
  requireAnyRole(["admin"]),
  (req, res) => {
    const format = String(req.query?.format || "").toLowerCase();
    if (format === "prometheus") {
      res.type("text/plain").send(toPrometheusLines());
      return undefined;
    }
    return sendSuccess(res, 200, getMetricsSnapshot());
  }
);

router.post(
  "/ingest",
  protect,
  requireAnyRole(["shipper", "carrier", "admin"]),
  (req, res) => {
    try {
      ingestClientMetrics(req.body || {});
      return sendSuccess(res, 202, { ingested: true });
    } catch (err) {
      return sendError(res, 500, err.message || "Server error");
    }
  }
);

module.exports = router;
