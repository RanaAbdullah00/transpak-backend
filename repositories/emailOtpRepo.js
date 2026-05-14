const { query } = require("../db/pool");

const PURPOSES = {
  REGISTER: "register_verify",
  PASSWORD_RESET: "password_reset"
};

async function invalidateOpen(email, purpose) {
  await query(
    `UPDATE email_otp_challenges
     SET consumed_at = now()
     WHERE lower(trim(email)) = lower(trim($1))
       AND purpose = $2
       AND consumed_at IS NULL`,
    [String(email || ""), purpose]
  );
}

async function insertChallenge({ email, purpose, codeHash, expiresAt }) {
  const { rows } = await query(
    `INSERT INTO email_otp_challenges (email, purpose, code_hash, expires_at)
     VALUES (lower(trim($1)), $2, $3, $4)
     RETURNING id, email, purpose, expires_at, created_at`,
    [String(email || ""), purpose, codeHash, expiresAt]
  );
  return rows[0] || null;
}

async function findLatestOpen(email, purpose) {
  const { rows } = await query(
    `SELECT id, email, purpose, code_hash, expires_at, consumed_at, attempt_count, created_at
     FROM email_otp_challenges
     WHERE lower(trim(email)) = lower(trim($1))
       AND purpose = $2
       AND consumed_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [String(email || ""), purpose]
  );
  return rows[0] || null;
}

async function lastSentAt(email, purpose) {
  const { rows } = await query(
    `SELECT max(created_at) AS last_at
     FROM email_otp_challenges
     WHERE lower(trim(email)) = lower(trim($1))
       AND purpose = $2`,
    [String(email || ""), purpose]
  );
  return rows[0]?.last_at || null;
}

async function incrementAttempts(id) {
  await query(
    `UPDATE email_otp_challenges
     SET attempt_count = attempt_count + 1
     WHERE id = $1`,
    [id]
  );
}

async function consume(id) {
  await query(
    `UPDATE email_otp_challenges
     SET consumed_at = now()
     WHERE id = $1 AND consumed_at IS NULL`,
    [id]
  );
}

module.exports = {
  PURPOSES,
  invalidateOpen,
  insertChallenge,
  findLatestOpen,
  lastSentAt,
  incrementAttempts,
  consume
};
