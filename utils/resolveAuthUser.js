const userRepo = require("../repositories/userRepo");
const { isDemoAdminEmail } = require("./demoAdmin");

/** Demo admin login/profile must always expose activeRole=admin in DB + API. */
async function resolveAuthUserForSession(user) {
  if (!user) return null;
  const email = String(user.email || "").trim().toLowerCase();
  if (!isDemoAdminEmail(email)) return user;
  if (user.activeRole === "admin") return user;
  const updated = await userRepo.setActiveRole(user.id, "admin");
  return updated || { ...user, activeRole: "admin" };
}

module.exports = { resolveAuthUserForSession };
