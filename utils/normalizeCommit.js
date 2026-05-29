/** Render-style commit prefix length (short SHA). */
const COMMIT_NORMALIZED_LEN = 12;

/**
 * Normalize git SHA for comparison (lowercase, first 12 chars).
 * @param {string|null|undefined} hash
 * @returns {string}
 */
function normalizeCommit(hash) {
  if (!hash) return "";
  const h = String(hash).trim().toLowerCase();
  if (!h || h === "unknown" || h === "local") return h;
  return h.substring(0, COMMIT_NORMALIZED_LEN);
}

/**
 * True when two commit refs refer to the same revision (12-char prefix).
 * @param {string} a
 * @param {string} b
 */
function commitsMatch(a, b) {
  const na = normalizeCommit(a);
  const nb = normalizeCommit(b);
  if (!na || !nb || na === "unknown" || nb === "unknown") return false;
  return na === nb;
}

module.exports = { normalizeCommit, commitsMatch, COMMIT_NORMALIZED_LEN };
