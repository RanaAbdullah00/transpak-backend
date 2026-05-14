/**
 * Lightweight structured logging (stdout). Swap for Winston/Datadog in production if needed.
 */
function line(level, msg, meta) {
  const base = { t: new Date().toISOString(), level, msg };
  if (meta && typeof meta === "object") Object.assign(base, meta);
  const s = JSON.stringify(base);
  if (level === "error") console.error(s);
  else if (level === "warn") console.warn(s);
  else console.log(s);
}

module.exports = {
  info: (msg, meta) => line("info", msg, meta),
  warn: (msg, meta) => line("warn", msg, meta),
  error: (msg, meta) => line("error", msg, meta)
};
