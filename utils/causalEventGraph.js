/**
 * Phase 7 — causal event graph (partial order over tracking events).
 */
const CAUSALITY_TYPES = Object.freeze({
  CREATE: "CREATE",
  UPDATE: "UPDATE",
  REPLAY: "REPLAY",
  CORRECTION: "CORRECTION"
});

function normalizeCausalityType(value, fallback = CAUSALITY_TYPES.UPDATE) {
  const v = String(value || fallback).toUpperCase();
  return Object.values(CAUSALITY_TYPES).includes(v) ? v : fallback;
}

function buildNode({
  eventId,
  sequenceId,
  parentEventId = null,
  causalityType = CAUSALITY_TYPES.UPDATE,
  payload = {}
}) {
  return {
    eventId: String(eventId || "").slice(0, 128),
    sequenceId: Number(sequenceId) || 0,
    parentEventId: parentEventId ? String(parentEventId).slice(0, 128) : null,
    causalityType: normalizeCausalityType(causalityType),
    payload: payload || {}
  };
}

function linkParent(node, parentEventId) {
  if (!node) return null;
  return {
    ...node,
    parentEventId: parentEventId ? String(parentEventId).slice(0, 128) : node.parentEventId
  };
}

function detectOrphans(nodes = []) {
  const byId = new Map(nodes.map((n) => [n.eventId, n]));
  const orphans = [];
  for (const node of nodes) {
    if (!node.parentEventId) {
      if (node.causalityType !== CAUSALITY_TYPES.CREATE && node.causalityType !== CAUSALITY_TYPES.REPLAY) {
        orphans.push({ ...node, reason: "missing_parent_non_root" });
      }
      continue;
    }
    if (!byId.has(node.parentEventId)) {
      orphans.push({ ...node, reason: "parent_not_found" });
    }
  }
  return orphans;
}

function validateGraphIntegrity(nodes = [], { isFirstEvent = false } = {}) {
  const orphans = detectOrphans(nodes);
  if (orphans.length === 0) return { ok: true, orphans: [] };

  const onlyMissingParentOnFirst =
    isFirstEvent &&
    orphans.length === 1 &&
    orphans[0].reason === "missing_parent_non_root";

  if (onlyMissingParentOnFirst) {
    return { ok: true, orphans: [], reconstructed: true };
  }

  return { ok: false, orphans };
}

function buildAdjacencyList(nodes = []) {
  const roots = [];
  const adj = {};
  const byId = new Map(nodes.map((n) => [n.eventId, n]));

  for (const node of nodes) {
    adj[node.eventId] = adj[node.eventId] || { node, children: [] };
    adj[node.eventId].node = node;
  }

  for (const node of nodes) {
    if (node.parentEventId && byId.has(node.parentEventId)) {
      adj[node.parentEventId] = adj[node.parentEventId] || { node: byId.get(node.parentEventId), children: [] };
      adj[node.parentEventId].children.push(node.eventId);
    } else if (!node.parentEventId || !byId.has(node.parentEventId)) {
      roots.push(node.eventId);
    }
  }

  roots.sort((a, b) => (byId.get(a)?.sequenceId || 0) - (byId.get(b)?.sequenceId || 0));
  return { roots, adj, byId };
}

function inferRootCausality(existingCount = 0) {
  return existingCount === 0 ? CAUSALITY_TYPES.CREATE : CAUSALITY_TYPES.UPDATE;
}

module.exports = {
  CAUSALITY_TYPES,
  buildNode,
  linkParent,
  detectOrphans,
  validateGraphIntegrity,
  buildAdjacencyList,
  normalizeCausalityType,
  inferRootCausality
};
