/** Lightweight request log (method + path + status + ms). */
function requestLogger(req, res, next) {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    if (res.statusCode >= 500 || (process.env.REQUEST_LOG_ALL === "true" && ms > 2000)) {
      // eslint-disable-next-line no-console
      console.log(`[http] ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
    }
  });
  next();
}

module.exports = { requestLogger };
