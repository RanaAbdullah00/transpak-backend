const { requireRole } = require("./authMiddleware");

/** Admin moderation APIs — DB roles[] must include admin. */
const requireAdminSession = requireRole("admin");

module.exports = { requireAdminSession };
