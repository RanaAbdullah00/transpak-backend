/**
 * Commercial workspace resolution — server-side isolation for dual-role accounts.
 * Sources (priority): X-TransPak-Workspace header → ?workspace= → ?viewAs= → DB active_role.
 */

const COMMERCIAL = new Set(["shipper", "carrier"]);

function normalizeWorkspace(value) {
  const r = String(value || "").trim().toLowerCase();
  if (r === "shipper" || r === "carrier" || r === "admin") return r;
  return null;
}

/**
 * @returns {{ workspace: string|null, error: string|null }}
 */
function resolveCommercialWorkspace(req) {
  const roles = (req.auth?.roles || []).map((r) => String(r).trim().toLowerCase());
  const commercial = roles.filter((r) => COMMERCIAL.has(r));
  const isAdmin = roles.includes("admin");

  const header = normalizeWorkspace(
    req.headers["x-transpak-workspace"] || req.headers["X-TransPak-Workspace"]
  );
  const queryWs = normalizeWorkspace(req.query?.workspace);
  const viewAs = normalizeWorkspace(req.query?.viewAs);
  const dbActive = normalizeWorkspace(req.user?.activeRole);

  const explicit = [header, queryWs, viewAs].filter(Boolean);
  for (const cand of explicit) {
    if (!roles.includes(cand)) {
      return { workspace: null, error: "FORBIDDEN_WORKSPACE" };
    }
  }
  if (header && queryWs && header !== queryWs) {
    return { workspace: null, error: "FORBIDDEN_WORKSPACE" };
  }
  if (header && viewAs && header !== viewAs) {
    return { workspace: null, error: "FORBIDDEN_WORKSPACE" };
  }
  if (queryWs && viewAs && queryWs !== viewAs) {
    return { workspace: null, error: "FORBIDDEN_WORKSPACE" };
  }

  const candidate = header || queryWs || viewAs || dbActive;

  if (!commercial.length) {
    if (isAdmin) return { workspace: "admin", error: null };
    return { workspace: candidate, error: null };
  }

  if (commercial.length === 1) {
    const only = commercial[0];
    const requested = header || queryWs || viewAs;
    if (requested && requested !== only) {
      return { workspace: null, error: "FORBIDDEN_WORKSPACE" };
    }
    return { workspace: only, error: null };
  }

  if (!candidate || !commercial.includes(candidate)) {
    return { workspace: null, error: "WORKSPACE_REQUIRED" };
  }

  return { workspace: candidate, error: null };
}

/** SQL party filter for shipment list queries scoped to workspace. */
function shipmentPartySql(workspace, uidParam = "$1") {
  const ws = normalizeWorkspace(workspace);
  if (ws === "shipper") return `l.shipper_id = ${uidParam}`;
  if (ws === "carrier") return `l.assigned_carrier_id = ${uidParam}`;
  return `(l.shipper_id = ${uidParam} OR l.assigned_carrier_id = ${uidParam})`;
}

module.exports = {
  normalizeWorkspace,
  resolveCommercialWorkspace,
  shipmentPartySql
};
