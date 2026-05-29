const { clientMessage, sanitizeErrorData } = require("./safeApiError");

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
      code: "INVALID_JSON",
      message: "Invalid JSON body",
      data: null,
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

  const message = clientMessage(status, err.message);

  if (status >= 500) {
    // eslint-disable-next-line no-console
    console.error("[api] error", req.method, req.originalUrl, isProd ? code : err?.message || err);
  }

  const payload = {
    success: false,
    code,
    message,
    data: sanitizeErrorData(err.data),
    error: code
  };

  return res.status(status).json(payload);
}

function registerProcessSafetyHandlers() {
  process.on("unhandledRejection", (reason) => {
    const msg = reason?.message || String(reason || "");
    // eslint-disable-next-line no-console
    console.error("[process] unhandledRejection:", msg);
    if (String(reason?.code || "") === "42703" || /does not exist/i.test(msg)) {
      // eslint-disable-next-line no-console
      console.error("[process] hint: run `npm run db:migrate` in transpak-backend");
    }
  });

  process.on("uncaughtException", (err) => {
    // eslint-disable-next-line no-console
    console.error("[process] uncaughtException:", err?.message || err);
  });
}

module.exports = { globalErrorMiddleware, registerProcessSafetyHandlers };
