/** Commercial list view — roles[] + optional validated ?viewAs= (never active_role). */

const COMMERCIAL = ["shipper", "carrier"];

function normalizeCommercialView(value) {
  const r = String(value || "").trim().toLowerCase();
  return COMMERCIAL.includes(r) ? r : null;
}

/**
 * @param {string[]} roles - req.auth.roles
 * @param {string|null|undefined} validatedView - req.commercialView from validateViewAs()
 * @param {string|null|undefined} userActiveRole - req.user.activeRole from DB
 * @returns {'shipper'|'carrier'|null}
 */
function resolveCommercialViewRole(roles, validatedView, userActiveRole = null) {
  const list = Array.isArray(roles)
    ? roles.map((r) => normalizeCommercialView(r)).filter(Boolean)
    : [];

  const v = normalizeCommercialView(validatedView);
  if (v && list.includes(v)) return v;

  const dbActive = normalizeCommercialView(userActiveRole);
  if (dbActive && list.includes(dbActive)) return dbActive;

  if (list.includes("carrier") && !list.includes("shipper")) return "carrier";
  if (list.includes("shipper") && !list.includes("carrier")) return "shipper";
  return null;
}

module.exports = { resolveCommercialViewRole, normalizeCommercialView };
