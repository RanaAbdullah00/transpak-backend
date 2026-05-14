const { query } = require("../db/pool");

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

/**
 * @param {string} email
 * @param {string} otpHash
 * @param {Date|string} expiresAt
 */
async function insertOtp(email, otpHash, expiresAt) {
  const em = normalizeEmail(email);
  const exp = expiresAt instanceof Date ? expiresAt.toISOString() : String(expiresAt);
  const { rows } = await query(
    `INSERT INTO auth_otp_codes (email, otp_hash, expires_at)
     VALUES ($1, $2, $3::timestamptz)
     RETURNING id, email, otp_hash, expires_at, is_verified, attempt_count, created_at`,
    [em, String(otpHash), exp]
  );
  return rows[0] || null;
}

/**
 * @param {string} email
 * @returns {Promise<object|null>}
 */
async function findLatestActive(email) {
  const em = normalizeEmail(email);
  const { rows } = await query(
    `SELECT id, email, otp_hash, expires_at, is_verified, attempt_count, created_at
     FROM auth_otp_codes
     WHERE lower(trim(email)) = $1
       AND is_verified = false
       AND expires_at > now()
     ORDER BY created_at DESC
     LIMIT 1`,
    [em]
  );
  return rows[0] || null;
}

/**
 * @param {string} email
 */
async function markVerified(email) {
  const em = normalizeEmail(email);
  const { rowCount } = await query(
    `UPDATE auth_otp_codes AS t
     SET is_verified = true
     FROM (
       SELECT id
       FROM auth_otp_codes
       WHERE lower(trim(email)) = $1
         AND is_verified = false
         AND expires_at > now()
       ORDER BY created_at DESC
       LIMIT 1
     ) AS sub
     WHERE t.id = sub.id`,
    [em]
  );
  return rowCount;
}

/**
 * @param {string} email
 */
async function incrementAttempts(email) {
  const em = normalizeEmail(email);
  const { rowCount } = await query(
    `UPDATE auth_otp_codes AS t
     SET attempt_count = attempt_count + 1
     FROM (
       SELECT id
       FROM auth_otp_codes
       WHERE lower(trim(email)) = $1
         AND is_verified = false
         AND expires_at > now()
       ORDER BY created_at DESC
       LIMIT 1
     ) AS sub
     WHERE t.id = sub.id`,
    [em]
  );
  return rowCount;
}

/**
 * @param {string} email
 */
async function expireOldOtps(email) {
  const em = normalizeEmail(email);
  const { rowCount } = await query(
    `UPDATE auth_otp_codes
     SET expires_at = now()
     WHERE lower(trim(email)) = $1
       AND is_verified = false
       AND expires_at > now()`,
    [em]
  );
  return rowCount;
}

/**
 * @param {string} email
 * @returns {Promise<Date|null>}
 */
async function getLastSentTime(email) {
  const em = normalizeEmail(email);
  const { rows } = await query(
    `SELECT max(created_at) AS last_at
     FROM auth_otp_codes
     WHERE lower(trim(email)) = $1`,
    [em]
  );
  const raw = rows[0]?.last_at;
  if (!raw) return null;
  return raw instanceof Date ? raw : new Date(raw);
}

module.exports = {
  insertOtp,
  findLatestActive,
  markVerified,
  incrementAttempts,
  expireOldOtps,
  getLastSentTime
};
