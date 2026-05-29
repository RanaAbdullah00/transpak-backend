const express = require("express");
const { sendSuccess, sendError } = require("../utils/apiResponse");
const { asyncHandler } = require("../utils/asyncHandler");
const { fetchWidgetByName, WIDGET_FETCHERS } = require("../utils/adminDashboardWidgets");

const router = express.Router();

const WIDGET_NAMES = Object.keys(WIDGET_FETCHERS);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    return sendSuccess(res, 200, { widgets: WIDGET_NAMES });
  })
);

router.get(
  "/:widget",
  asyncHandler(async (req, res) => {
    const widget = String(req.params.widget || "").trim().toLowerCase();
    if (!WIDGET_NAMES.includes(widget)) {
      return sendError(res, 404, "Unknown widget", null, "NOT_FOUND");
    }

    const result = await fetchWidgetByName(widget);
    if (!result.ok) {
      return sendSuccess(res, 200, {
        ok: false,
        widget,
        error: result.error,
        durationMs: result.durationMs
      });
    }

    return sendSuccess(res, 200, {
      ok: true,
      widget,
      durationMs: result.durationMs,
      ...result.data
    });
  })
);

module.exports = router;
