const { query, getPool } = require("../db/pool");
const { sanitizeRolesForStorage } = require("../utils/rolePolicy");
const { ALLOWED_ROLES, normalizeRole, hasRole } = require("../utils/roleConstants");

function normalizeRoleExport(value) {
  return normalizeRole(value);
}

function hasRoleExport(user, role) {
  return hasRole(user, role);
}

function toAuthUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    _id: row.id,
    email: row.email,
    roles: Array.isArray(row.roles) ? row.roles : [],
    activeRole: row.active_role,
    blocked: Boolean(row.blocked),
    verified: Boolean(row.verified),

    name: row.full_name || row.email,
    cnic: row.cnic_number || "",

    fullName: row.full_name || "",
    phone: row.phone || "",
    cnicNumber: row.cnic_number || "",
    cnicImage: row.cnic_image || "",
    cnicImageBack: row.cnic_image_back || "",
    profileImage: row.profile_image || "",
    isProfileComplete: Boolean(row.is_profile_complete)
  };
}

async function findById(id) {
  const { rows } = await query(
    `SELECT id, email, roles, active_role, blocked, verified,
            full_name, phone, cnic_number, cnic_image, cnic_image_back, profile_image, is_profile_complete
     FROM users
     WHERE id = $1`,
    [id]
  );
  return toAuthUser(rows[0]);
}

async function findRowByEmailWithPassword(email) {
  const { rows } = await query(
    `SELECT id, email, roles, active_role, blocked, verified,
            full_name, phone, cnic_number, cnic_image, cnic_image_back, profile_image, is_profile_complete,
            password_hash
     FROM users
     WHERE lower(trim(email)) = lower(trim($1))`,
    [String(email || "").trim().toLowerCase()]
  );
  return rows[0] || null;
}

async function findByEmail(email) {
  const { rows } = await query(
    `SELECT id, email, roles, active_role, blocked, verified,
            full_name, phone, cnic_number, cnic_image, cnic_image_back, profile_image, is_profile_complete
     FROM users
     WHERE lower(trim(email)) = lower(trim($1))`,
    [String(email || "").trim().toLowerCase()]
  );
  return toAuthUser(rows[0]);
}

/** Owner of this phone (for duplicate checks). */
async function findPhoneOwner(phone) {
  const { rows } = await query(`SELECT id, email FROM users WHERE phone = $1`, [String(phone || "").trim()]);
  return rows[0] || null;
}

async function findByCnicNumber(cnicNumber) {
  const { rows } = await query(
    `SELECT id, email, roles, active_role, blocked, verified,
            full_name, phone, cnic_number, cnic_image, cnic_image_back, profile_image, is_profile_complete
     FROM users
     WHERE cnic_number = $1`,
    [String(cnicNumber || "").trim()]
  );
  return toAuthUser(rows[0]);
}

async function createUser({ email, passwordHash, roles, activeRole, phone, cnicNumber, fullName, verified = false }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const sanitized = sanitizeRolesForStorage(roles, activeRole);
  const cleanRoles = sanitized.roles;
  const active = sanitized.activeRole;
  const fn = fullName != null ? String(fullName).trim() : null;

  const { rows } = await query(
    `INSERT INTO users (email, password_hash, roles, active_role, phone, cnic_number, full_name, verified)
     VALUES ($1, $2, $3::text[], $4, $5, $6, $7, $8)
     RETURNING id, email, roles, active_role, blocked, verified,
               full_name, phone, cnic_number, cnic_image, cnic_image_back, profile_image, is_profile_complete`,
    [
      normalizedEmail,
      passwordHash,
      cleanRoles,
      active,
      phone != null ? String(phone).trim() : null,
      cnicNumber != null ? String(cnicNumber).trim() : null,
      fn || null,
      Boolean(verified)
    ]
  );
  return toAuthUser(rows[0]);
}

async function addRole(userId, role) {
  const r = normalizeRole(role);
  if (!r || r === "admin") return null;
  const existing = await findById(userId);
  if (!existing) return null;
  const { validateAddRole } = require("../utils/rolePolicy");
  const check = validateAddRole(existing, r);
  if (!check.ok) return null;
  if (check.already) return existing;
  return setRolesAndActive(userId, [r], r);
}

async function setRolesAndActive(userId, roles, activeRole) {
  const sanitized = sanitizeRolesForStorage(roles, activeRole);
  const { rows } = await query(
    `UPDATE users
     SET roles = $2::text[], active_role = $3, updated_at = now()
     WHERE id = $1
     RETURNING id, email, roles, active_role, blocked, verified,
               full_name, phone, cnic_number, cnic_image, cnic_image_back, profile_image, is_profile_complete`,
    [userId, sanitized.roles, sanitized.activeRole]
  );
  return toAuthUser(rows[0]);
}

/** Repair legacy dual-role / admin+commercial rows at login. */
async function enforceSingleRolePolicy(userId) {
  const user = await findById(userId);
  if (!user) return null;
  const sanitized = sanitizeRolesForStorage(user.roles, user.activeRole);
  const sameRoles =
    JSON.stringify([...(user.roles || [])].sort()) === JSON.stringify([...sanitized.roles].sort());
  if (sameRoles && user.activeRole === sanitized.activeRole) return user;
  return setRolesAndActive(userId, sanitized.roles, sanitized.activeRole);
}

async function setCnicIfEmpty(userId, cnicNumber) {
  const c = String(cnicNumber || "").trim();
  if (!c) return null;
  const { rows } = await query(
    `UPDATE users
     SET cnic_number = $2, updated_at = now()
     WHERE id = $1 AND cnic_number IS NULL
     RETURNING id, email, roles, active_role, blocked, verified,
               full_name, phone, cnic_number, cnic_image, cnic_image_back, profile_image, is_profile_complete`,
    [userId, c]
  );
  return toAuthUser(rows[0]);
}

async function setPhoneIfEmpty(userId, phone) {
  const p = String(phone || "").trim();
  if (!p) return null;
  const { rows } = await query(
    `UPDATE users
     SET phone = $2, updated_at = now()
     WHERE id = $1 AND (phone IS NULL OR TRIM(phone) = '')
     RETURNING id, email, roles, active_role, blocked, verified,
               full_name, phone, cnic_number, cnic_image, cnic_image_back, profile_image, is_profile_complete`,
    [userId, p]
  );
  return toAuthUser(rows[0]);
}

async function setFullNameIfEmpty(userId, fullName) {
  const n = String(fullName || "").trim();
  if (!n) return null;
  const { rows } = await query(
    `UPDATE users
     SET full_name = $2, updated_at = now()
     WHERE id = $1 AND (full_name IS NULL OR TRIM(full_name) = '')
     RETURNING id, email, roles, active_role, blocked, verified,
               full_name, phone, cnic_number, cnic_image, cnic_image_back, profile_image, is_profile_complete`,
    [userId, n]
  );
  return toAuthUser(rows[0]);
}

async function setActiveRole(userId, nextRole) {
  const user = await findById(userId);
  if (!user) return null;
  const { validateRoleMutation } = require("../utils/rolePolicy");
  const check = validateRoleMutation(user, nextRole);
  if (!check.ok) return null;
  return setRolesAndActive(userId, check.roles, check.activeRole);
}

const USER_RETURNING = `id, email, roles, active_role, blocked, verified,
  full_name, phone, cnic_number, cnic_image, cnic_image_back, profile_image, is_profile_complete`;

/**
 * Atomically ensure role is on account (except admin) and set active_role.
 * Caller must reject admin if not already in roles[].
 */
async function switchActiveRole(userId, nextRole) {
  const role = normalizeRole(nextRole);
  if (!role) return null;

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: locked } = await client.query(
      `SELECT roles, active_role FROM users WHERE id = $1 FOR UPDATE`,
      [userId]
    );
    if (!locked[0]) {
      await client.query("ROLLBACK");
      return null;
    }

    const roles = Array.isArray(locked[0].roles) ? locked[0].roles.map(normalizeRole).filter(Boolean) : [];
    const user = { id: userId, roles, activeRole: locked[0].active_role };
    const { validateRoleMutation } = require("../utils/rolePolicy");
    const check = validateRoleMutation(user, role);
    if (!check.ok || !check.roles.includes(role)) {
      await client.query("ROLLBACK");
      return null;
    }

    const { rows } = await client.query(
      `UPDATE users
       SET roles = $2::text[], active_role = $3, updated_at = now()
       WHERE id = $1
       RETURNING ${USER_RETURNING}`,
      [userId, check.roles, check.activeRole]
    );
    await client.query("COMMIT");
    return toAuthUser(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function upsertDemoAdmin({ email, passwordHash, roles, activeRole, phone, cnicNumber, fullName }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const sanitized = sanitizeRolesForStorage(roles || ["admin"], activeRole || "admin");
  const cleanRoles = sanitized.roles.includes("admin") ? ["admin"] : sanitized.roles;
  const active = sanitized.roles.includes("admin") ? "admin" : sanitized.activeRole;
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, roles, active_role, phone, cnic_number, full_name, verified)
     VALUES ($1, $2, $3::text[], $4, $5, $6, $7, true)
     ON CONFLICT (email)
     DO UPDATE SET
       password_hash = COALESCE(NULLIF(users.password_hash, ''), EXCLUDED.password_hash),
       roles = EXCLUDED.roles,
       active_role = EXCLUDED.active_role,
       phone = COALESCE(users.phone, EXCLUDED.phone),
       cnic_number = COALESCE(users.cnic_number, EXCLUDED.cnic_number),
       full_name = COALESCE(users.full_name, EXCLUDED.full_name),
       updated_at = now()
     RETURNING id, email, roles, active_role, blocked, verified,
               full_name, phone, cnic_number, cnic_image, cnic_image_back, profile_image, is_profile_complete`,
    [
      normalizedEmail,
      passwordHash,
      cleanRoles,
      active,
      phone ? String(phone).trim() : null,
      cnicNumber ? String(cnicNumber).trim() : null,
      fullName ? String(fullName).trim() : null
    ]
  );
  return toAuthUser(rows[0]);
}

async function setVerifiedByEmail(email, verified = true) {
  const { rows } = await query(
    `UPDATE users
     SET verified = $2, updated_at = now()
     WHERE lower(trim(email)) = lower(trim($1))
     RETURNING id, email, roles, active_role, blocked, verified,
               full_name, phone, cnic_number, cnic_image, cnic_image_back, profile_image, is_profile_complete`,
    [String(email || ""), Boolean(verified)]
  );
  return toAuthUser(rows[0]);
}

async function updatePasswordHashByEmail(email, passwordHash) {
  const { rows } = await query(
    `UPDATE users
     SET password_hash = $2, updated_at = now()
     WHERE lower(trim(email)) = lower(trim($1))
     RETURNING id, email, roles, active_role, blocked, verified,
               full_name, phone, cnic_number, cnic_image, cnic_image_back, profile_image, is_profile_complete`,
    [String(email || ""), passwordHash]
  );
  return toAuthUser(rows[0]);
}

module.exports = {
  ALLOWED_ROLES,
  normalizeRole: normalizeRoleExport,
  hasRole: hasRoleExport,
  findById,
  findByEmail,
  findRowByEmailWithPassword,
  findPhoneOwner,
  findByCnicNumber,
  createUser,
  addRole,
  setCnicIfEmpty,
  setPhoneIfEmpty,
  setFullNameIfEmpty,
  setActiveRole,
  setRolesAndActive,
  enforceSingleRolePolicy,
  switchActiveRole,
  upsertDemoAdmin,
  setVerifiedByEmail,
  updatePasswordHashByEmail
};
