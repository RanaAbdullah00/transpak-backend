/**
 * Clears OTP / pending-signup state for a single email. Used by:
 * - scripts/devResetTestAuth.js (explicit CLI, you pass --email=...)
 * - runtime DEV_MODE + DEV_AUTH_TEST_EMAILS allowlist (see authController / emailOtpController)
 *
 * Does NOT delete users unless `deleteUserRow` is true (script-only, extra guard there).
 * Never invoke deleteUserRow from HTTP handlers.
 */

const { query } = require("../db/pool");

/**
 * @param {import("pg").PoolClient} [client] optional transaction client
 * @param {string} email
 */
async function clearPendingRegistrationForEmail(client, email) {
  const em = String(email || "").trim().toLowerCase();
  const run = client ? client.query.bind(client) : query;
  await run(`DELETE FROM pending_registrations WHERE lower(trim(email)) = lower(trim($1))`, [em]);
}

/**
 * All rows for this email (open + consumed) so attempt counters and history do not block retests.
 */
async function clearEmailOtpChallengesForEmail(client, email) {
  const em = String(email || "").trim().toLowerCase();
  const run = client ? client.query.bind(client) : query;
  await run(`DELETE FROM email_otp_challenges WHERE lower(trim(email)) = lower(trim($1))`, [em]);
}

async function clearAuthOtpCodesForEmail(client, email) {
  const em = String(email || "").trim().toLowerCase();
  const run = client ? client.query.bind(client) : query;
  await run(`DELETE FROM auth_otp_codes WHERE lower(trim(email)) = $1`, [em]);
}

/** Email OTP challenges + generic auth_otp_codes only (keeps pending_registrations). */
async function clearOtpTablesForEmail(email, opts = {}) {
  const { client } = opts;
  await clearEmailOtpChallengesForEmail(client, email);
  await clearAuthOtpCodesForEmail(client, email);
}

/**
 * OTP tables + pending signup row for one email. User row unchanged.
 *
 * @param {string} email
 * @param {{ client?: import("pg").PoolClient }} [opts]
 */
async function clearOtpAndPendingForEmail(email, opts = {}) {
  const { client } = opts;
  await clearPendingRegistrationForEmail(client, email);
  await clearEmailOtpChallengesForEmail(client, email);
  await clearAuthOtpCodesForEmail(client, email);
}

/**
 * Full reset used by CLI script: OTP + pending; optional unverify; optional delete user.
 *
 * @param {object} p
 * @param {string} p.email
 * @param {boolean} [p.unverifyUser]
 * @param {boolean} [p.deleteUserRow]
 */
async function resetTestAccountByEmail({ email, unverifyUser = false, deleteUserRow = false }) {
  const em = String(email || "").trim().toLowerCase();
  await clearOtpAndPendingForEmail(em);
  if (unverifyUser) {
    await query(`UPDATE users SET verified = false, updated_at = now() WHERE lower(trim(email)) = lower(trim($1))`, [em]);
  }
  if (deleteUserRow) {
    await query(`DELETE FROM users WHERE lower(trim(email)) = lower(trim($1))`, [em]);
  }
}

module.exports = {
  clearPendingRegistrationForEmail,
  clearEmailOtpChallengesForEmail,
  clearAuthOtpCodesForEmail,
  clearOtpTablesForEmail,
  clearOtpAndPendingForEmail,
  resetTestAccountByEmail
};
