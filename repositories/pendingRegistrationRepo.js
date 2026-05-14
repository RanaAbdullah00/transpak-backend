const { query } = require("../db/pool");

async function findByEmail(email) {
  const em = String(email || "").trim().toLowerCase();
  const { rows } = await query(
    `SELECT email, phone, cnic_number, full_name, password_hash, role, code_hash, expires_at, attempt_count, created_at, updated_at
     FROM pending_registrations
     WHERE lower(trim(email)) = lower(trim($1))`,
    [em]
  );
  return rows[0] || null;
}

async function upsert({ email, phone, cnicNumber, fullName, passwordHash, role, codeHash, expiresAt }) {
  const em = String(email || "").trim().toLowerCase();
  const r = String(role || "").trim().toLowerCase();
  await query(
    `INSERT INTO pending_registrations (email, phone, cnic_number, full_name, password_hash, role, code_hash, expires_at, attempt_count, updated_at)
     VALUES (lower(trim($1)), $2, $3, $4, $5, $6, $7, $8, 0, now())
     ON CONFLICT (email) DO UPDATE SET
       phone = EXCLUDED.phone,
       cnic_number = EXCLUDED.cnic_number,
       full_name = EXCLUDED.full_name,
       password_hash = EXCLUDED.password_hash,
       role = EXCLUDED.role,
       code_hash = EXCLUDED.code_hash,
       expires_at = EXCLUDED.expires_at,
       attempt_count = 0,
       updated_at = now()`,
    [
      em,
      String(phone || "").trim(),
      String(cnicNumber || "").trim(),
      fullName != null ? String(fullName).trim() : null,
      String(passwordHash),
      r,
      String(codeHash),
      expiresAt
    ]
  );
}

async function incrementAttempts(email) {
  await query(
    `UPDATE pending_registrations
     SET attempt_count = attempt_count + 1, updated_at = now()
     WHERE lower(trim(email)) = lower(trim($1))`,
    [String(email || "").trim().toLowerCase()]
  );
}

async function deleteByEmail(email) {
  await query(`DELETE FROM pending_registrations WHERE lower(trim(email)) = lower(trim($1))`, [
    String(email || "").trim().toLowerCase()
  ]);
}

async function lastUpdatedAt(email) {
  const { rows } = await query(
    `SELECT updated_at FROM pending_registrations WHERE lower(trim(email)) = lower(trim($1))`,
    [String(email || "").trim().toLowerCase()]
  );
  return rows[0]?.updated_at || null;
}

module.exports = {
  findByEmail,
  upsert,
  incrementAttempts,
  deleteByEmail,
  lastUpdatedAt
};
