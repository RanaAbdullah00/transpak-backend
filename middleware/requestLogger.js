const { recordHttpRequest } = require("../utils/opsTelemetry");

/** Lightweight request log (method + path + status + ms) + ops telemetry. */
function requestLogger(req, res, next) {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    const path = req.originalUrl || req.url || "";
    recordHttpRequest(req.method, path, res.statusCode, ms);
    if (res.statusCode >= 500 || (process.env.REQUEST_LOG_ALL === "true" && ms > 2000)) {
      // eslint-disable-next-line no-console
      console.log(`[http] ${req.method} ${path} ${res.statusCode} ${ms}ms`);
    }
  });
  next();
}

module.exports = { requestLogger };
