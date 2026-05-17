/**
 * Central Express error middleware — never leak stack traces in production.
 */
function globalErrorMiddleware(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  const isProd = process.env.NODE_ENV === "production";

  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({
      success: false,
      message: "Invalid JSON body",
      data: null,
      code: "INVALID_JSON",
      error: "INVALID_JSON"
    });
  }

  let status = Number(err.statusCode || err.status) || 500;
  if (!Number.isFinite(status) || status < 400 || status > 599) {
    status = 500;
  }

  const rawCode = err.code != null ? String(err.code) : "";
  const code =
    rawCode && !/^(E[A-Z]+|\d+)$/.test(rawCode) && rawCode.length < 64
      ? rawCode
      : status >= 500
        ? "SERVER_ERROR"
        : "ERROR";

  const message =
    isProd && status >= 500 ? "Something went wrong" : err.message || "Something went wrong";

  if (status >= 500) {
    // eslint-disable-next-line no-console
    console.error("[api] error", req.method, req.originalUrl, isProd ? code : err?.message || err);
  }

  const payload = {
    success: false,
    message,
    data: err.data !== undefined ? err.data : null,
    code,
    error: code
  };

  return res.status(status).json(payload);
}

function registerProcessSafetyHandlers() {
  process.on("unhandledRejection", (reason) => {
    // eslint-disable-next-line no-console
    console.error("[process] unhandledRejection:", reason?.message || reason);
  });

  process.on("uncaughtException", (err) => {
    // eslint-disable-next-line no-console
    console.error("[process] uncaughtException:", err?.message || err);
  });
}

module.exports = { globalErrorMiddleware, registerProcessSafetyHandlers };
