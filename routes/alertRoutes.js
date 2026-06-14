const express = require("express");
const { protect, requireAnyRole } = require("../middleware/authMiddleware");
const { sendSuccess } = require("../utils/apiResponse");
const { listAlerts, getRecentAlerts } = require("../utils/alertEngine");

const router = express.Router();

router.get(
  "/",
  protect,
  requireAnyRole(["admin"]),
  async (req, res) => {
    const alerts = await listAlerts({
      limit: req.query?.limit,
      severity: req.query?.severity
    });
    return sendSuccess(res, 200, { count: alerts.length, alerts });
  }
);

router.get(
  "/stream",
  protect,
  requireAnyRole(["admin"]),
  (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    let cursor = 0;
    const tick = () => {
      const alerts = getRecentAlerts();
      const slice = alerts.slice(0, 20);
      if (slice.length !== cursor) {
        cursor = slice.length;
        res.write(`data: ${JSON.stringify({ alerts: slice })}\n\n`);
      }
    };
    tick();
    const timer = setInterval(tick, 3000);
    req.on("close", () => clearInterval(timer));
  }
);

module.exports = router;
