const { query } = require("../db/pool");

const ALLOWED_ROLES = ["shipper", "carrier", "admin"];

function normalizeRole(value) {
  const v = String(value || "").trim().toLowerCase();
  return ALLOWED_ROLES.includes(v) ? v : null;
}

function hasRole(user, role) {
  const r = normalizeRole(role);
  if (!r || !user) return false;
  const list = Array.isArray(user.roles) ? user.roles : [];
  return list.includes(r);
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
     WHERE email = $1`,
    [String(email || "").trim().toLowerCase()]
  );
  return rows[0] || null;
}

async function findByEmail(email) {
  const { rows } = await query(
    `SELECT id, email, roles, active_role, blocked, verified,
            full_name, phone, cnic_number, cnic_image, cnic_image_back, profile_image, is_profile_complete
     FROM users
     WHERE email = $1`,
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
  const cleanRoles = Array.isArray(roles)
    ? [...new Set(roles.map(normalizeRole).filter(Boolean))]
    : [];
  const active = normalizeRole(activeRole) || cleanRoles[0] || "shipper";
  if (!cleanRoles.includes(active)) cleanRoles.unshift(active);
  if (!cleanRoles.length) cleanRoles.push("shipper");
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
  const { rows } = await query(
    `UPDATE users
     SET roles = (
       SELECT ARRAY(
         SELECT DISTINCT unnest(COALESCE(roles, ARRAY[]::text[]) || ARRAY[$2::text])
       )
     ),
     updated_at = now()
     WHERE id = $1
     RETURNING id, email, roles, active_role, blocked, verified,
               full_name, phone, cnic_number, cnic_image, cnic_image_back, profile_image, is_profile_complete`,
    [userId, r]
  );
  return toAuthUser(rows[0]);
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
  const role = normalizeRole(nextRole);
  if (!role) return null;
  const { rows } = await query(
    `UPDATE users
     SET active_role = $2, updated_at = now()
     WHERE id = $1
     RETURNING id, email, roles, active_role, blocked, verified,
               full_name, phone, cnic_number, cnic_image, cnic_image_back, profile_image, is_profile_complete`,
    [userId, role]
  );
  return toAuthUser(rows[0]);
}

async function upsertDemoAdmin({ email, passwordHash, roles, activeRole, phone, cnicNumber, fullName }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const cleanRoles = Array.isArray(roles)
    ? [...new Set(roles.map(normalizeRole).filter(Boolean))]
    : ["admin"];
  const active = normalizeRole(activeRole) || "admin";
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, roles, active_role, phone, cnic_number, full_name, verified)
     VALUES ($1, $2, $3::text[], $4, $5, $6, $7, true)
     ON CONFLICT (email)
     DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       roles = (SELECT ARRAY(SELECT DISTINCT unnest(users.roles || EXCLUDED.roles))),
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
  normalizeRole,
  hasRole,
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
  upsertDemoAdmin,
  setVerifiedByEmail,
  updatePasswordHashByEmail
};
