function roleFlags(roles) {
  const r = Array.isArray(roles) ? roles : [];
  return {
    hasShipper: r.includes("shipper"),
    hasCarrier: r.includes("carrier")
  };
}

/**
 * Build the JSON user shape for auth responses.
 * Supports plain objects from userRepo (PostgreSQL) and legacy Mongoose `toAuthJSON()`.
 */
function normalizeRolesList(roles) {
  if (Array.isArray(roles)) return roles.filter(Boolean);
  const s = String(roles || '').trim();
  if (!s) return [];
  if (s.startsWith('{') && s.endsWith('}')) {
    return s
      .slice(1, -1)
      .split(',')
      .map((r) => r.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);
  }
  return [s];
}

function serializeAuthUser(user) {
  if (!user) return null;
  if (typeof user.toAuthJSON === "function") return user.toAuthJSON();

  const id = user.id || user._id;
  const idStr = id != null ? String(id) : undefined;
  const roles = normalizeRolesList(user.roles);
  return {
    id: idStr,
    _id: idStr,
    email: user.email,
    name: user.name || user.fullName || user.email,
    roles,
    activeRole: user.activeRole,
    blocked: Boolean(user.blocked),
    verified: Boolean(user.verified),
    fullName: user.fullName || user.name || "",
    phone: user.phone || "",
    cnicNumber: user.cnicNumber || user.cnic || "",
    cnicImage: user.cnicImage || "",
    profileImage: user.profileImage || "",
    profileComplete: Boolean(user.isProfileComplete ?? user.profileComplete)
  };
}

function authData(user, token) {
  const roles = normalizeRolesList(user.roles);
  return {
    user: serializeAuthUser(user),
    token,
    roles: roleFlags(roles),
    currentRole: user.activeRole
  };
}

/** Login-only payload: minimal user + token (full profile from GET /profile). */
function loginAuthData(user, token) {
  const roles = normalizeRolesList(user.roles);
  const idStr = String(user.id || user._id || "");
  return {
    token,
    user: {
      id: idStr,
      _id: idStr,
      email: user.email,
      roles,
      activeRole: user.activeRole,
      verified: Boolean(user.verified),
      profileImage: user.profileImage || user.profile_image || "",
      fullName: user.fullName || user.full_name || user.name || "",
      profileComplete: Boolean(user.isProfileComplete ?? user.profileComplete)
    },
    roles: roleFlags(roles),
    currentRole: user.activeRole
  };
}

function authDataNoToken(user) {
  const roles = normalizeRolesList(user.roles);
  return {
    user: serializeAuthUser(user),
    roles: roleFlags(roles),
    currentRole: user.activeRole
  };
}

module.exports = { authData, authDataNoToken, loginAuthData, roleFlags, serializeAuthUser };
