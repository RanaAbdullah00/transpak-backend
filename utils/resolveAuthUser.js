const { isDemoAdminEmail } = require("./demoAdmin");
const { resolveAuthUserForSession } = require("./authSessionPolicy");

module.exports = { resolveAuthUserForSession, isDemoAdminEmail };
