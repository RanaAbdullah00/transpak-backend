const path = require("path");
const { version: APP_VERSION } = require(path.join(__dirname, "..", "package.json"));
const { BUILD_ID } = require("../utils/deployIdentity");

/** Attach build metadata on every response so clients can detect stale deploys. */
function deployHeaders(req, res, next) {
  res.setHeader("X-TransPak-Version", APP_VERSION);
  res.setHeader("X-TransPak-Build", BUILD_ID);
  if (req.path && String(req.path).startsWith("/api")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
  }
  next();
}

module.exports = { deployHeaders, APP_VERSION, BUILD_ID };
