/**
 * Prevent SQL / stack / schema details from reaching API clients in production.
 */

const LEAK_PATTERNS = [
  /syntax error/i,
  /relation\s+"?[\w.]+"?/i,
  /column\s+"?[\w.]+"?/i,
  /duplicate key/i,
  /violates\s+(foreign key|unique|check)/i,
  /postgres/i,
  /pg_/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /at\s+[\w.]+\s+\(/,
  /\.js:\d+:\d+/,
  /node_modules/i
];

function isProduction() {
  return process.env.NODE_ENV === "production";
}

function looksLikeLeak(message) {
  const msg = String(message || "");
  if (!msg || msg.length > 500) return true;
  return LEAK_PATTERNS.some((re) => re.test(msg));
}

function clientMessage(statusCode, message) {
  const status = Number(statusCode) || 500;
  const raw = String(message || "").trim();
  if (!isProduction()) return raw || (status >= 500 ? "Server error" : "Request failed");
  if (status >= 500) return "Something went wrong";
  if (status === 404) return "Not found";
  if (status === 403) return raw && !looksLikeLeak(raw) ? raw : "Forbidden";
  if (status === 401) return "Unauthorized";
  if (looksLikeLeak(raw)) return status >= 400 && status < 500 ? "Request failed" : "Something went wrong";
  return raw || "Request failed";
}

function sanitizeErrorData(data) {
  if (!isProduction() || data == null) return data;
  if (typeof data !== "object") return null;
  const out = { ...data };
  delete out.lastError;
  delete out.stack;
  delete out.detail;
  delete out.hint;
  delete out.internal;
  return Object.keys(out).length ? out : null;
}

module.exports = { clientMessage, looksLikeLeak, sanitizeErrorData, isProduction };
