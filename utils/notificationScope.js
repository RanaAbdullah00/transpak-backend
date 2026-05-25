/**
 * Inbox scope by DB roles[] only (reads/updates — not route authorization).
 * @param {{ roles?: string[] }} ctx
 */
function notificationScopeClause(ctx) {
  const roles = (ctx?.roles || [])
    .map((r) => String(r).trim().toLowerCase())
    .filter(Boolean);
  const commercial = roles.filter((r) => r === "shipper" || r === "carrier");
  const adminOnly = roles.includes("admin") && commercial.length === 0;

  if (adminOnly) {
    return {
      sql: `(role_type IS NULL OR TRIM(role_type) = '' OR LOWER(role_type) = 'admin')`,
      params: []
    };
  }

  const allowed = [...new Set(commercial)];
  if (roles.includes("admin")) allowed.push("admin");

  if (!allowed.length) {
    return {
      sql: `(role_type IS NULL OR TRIM(role_type) = '' OR LOWER(role_type) = 'all')`,
      params: []
    };
  }

  return {
    sql: `(role_type IS NULL OR TRIM(role_type) = '' OR LOWER(role_type) = 'all' OR LOWER(role_type) = ANY($2::text[]))`,
    params: [allowed]
  };
}

module.exports = { notificationScopeClause };
