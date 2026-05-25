/**
 * Classify PostgreSQL / pool errors for safe API responses (no secrets).
 */
function isTransientDbError(err) {
  const code = String(err?.code || "");
  const msg = String(err?.message || err || "").toLowerCase();
  if (["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EPIPE"].includes(code)) return true;
  if (msg.includes("connection terminated") || msg.includes("connection timeout")) return true;
  if (msg.includes("timeout") && msg.includes("connect")) return true;
  return false;
}

function isDbAuthError(err) {
  const code = String(err?.code || "");
  if (code === "28P01") return true;
  return String(err?.message || "").toLowerCase().includes("password authentication failed");
}

function classifyDbError(err) {
  if (!err) {
    return { code: "SERVER_ERROR", status: 500, message: "Database error", log: "unknown" };
  }
  if (isDbAuthError(err)) {
    return {
      code: "DATABASE_AUTH_FAILED",
      status: 503,
      message: "Database authentication failed. Check DATABASE_URL on the server.",
      log: err.message
    };
  }
  if (isTransientDbError(err)) {
    return {
      code: "DATABASE_TIMEOUT",
      status: 503,
      message: "Database connection timed out. Try again in a moment.",
      log: err.message || String(err)
    };
  }
  const pgCode = String(err?.code || "");
  if (pgCode === "57P01" || pgCode === "57P03") {
    return {
      code: "DATABASE_UNAVAILABLE",
      status: 503,
      message: "Database is unavailable. Try again shortly.",
      log: err.message
    };
  }
  return {
    code: "SERVER_ERROR",
    status: 500,
    message: "Database error",
    log: err.message || String(err)
  };
}

module.exports = { isTransientDbError, isDbAuthError, classifyDbError };
