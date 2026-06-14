/**
 * Phase 7 — causal replay engine (graph reconstruction + divergence detection).
 */
const { getShipmentReplayEvents } = require("../utils/shipmentEventLog");
const { buildAdjacencyList, CAUSALITY_TYPES } = require("../utils/causalEventGraph");
const { query } = require("../db/pool");

async function getShipmentEventsWithCausality(shipmentId, opts = {}) {
  const cap = Math.min(1000, Math.max(1, Number(opts.limit) || 500));
  try {
    const { rows } = await query(
      `SELECT event_id AS "eventId", sequence_id AS "sequenceId", source,
              parent_event_id AS "parentEventId", causality_type AS "causalityType",
              payload, created_at AS "timestamp"
       FROM shipment_event_log
       WHERE shipment_id = $1
       ORDER BY sequence_id ASC, created_at ASC
       LIMIT $2`,
      [shipmentId, cap]
    );
    return rows;
  } catch {
    return getShipmentReplayEvents(shipmentId, opts);
  }
}

function findDivergencePoints(nodes = [], adj = {}) {
  const points = [];
  for (const node of nodes) {
    if (node.causalityType === CAUSALITY_TYPES.CORRECTION) {
      points.push({
        eventId: node.eventId,
        sequenceId: node.sequenceId,
        parentEventId: node.parentEventId,
        reason: node.payload?.reason || "correction"
      });
    }
    const entry = adj[node.eventId];
    if (entry && entry.children.length > 1) {
      points.push({
        eventId: node.eventId,
        sequenceId: node.sequenceId,
        branchCount: entry.children.length,
        reason: "multi_child_branch"
      });
    }
  }
  return points;
}

function buildCausalTreeFromEvents(events = []) {
  const nodes = events.map((e) => ({
    eventId: e.eventId,
    sequenceId: e.sequenceId,
    parentEventId: e.parentEventId || null,
    causalityType: e.causalityType || CAUSALITY_TYPES.CREATE,
    payload: e.payload || {}
  }));
  const { roots, adj } = buildAdjacencyList(nodes);
  const nodeMap = {};
  for (const [eventId, entry] of Object.entries(adj)) {
    nodeMap[eventId] = {
      eventId,
      sequenceId: entry.node?.sequenceId || 0,
      causalityType: entry.node?.causalityType || CAUSALITY_TYPES.UPDATE,
      children: entry.children || []
    };
  }
  const corrections = nodes
    .filter((n) => n.causalityType === CAUSALITY_TYPES.CORRECTION)
    .map((n) => n.eventId);
  const divergencePoints = findDivergencePoints(nodes, adj);
  return {
    roots,
    nodes: nodeMap,
    divergencePoints,
    corrections
  };
}

async function buildCausalTree(shipmentId, opts = {}) {
  const events = await getShipmentEventsWithCausality(shipmentId, opts);
  return {
    shipmentId,
    count: events.length,
    events,
    causal: buildCausalTreeFromEvents(events)
  };
}

function deterministicStateAtSequence(events = [], targetSeq = 0) {
  const seq = Number(targetSeq) || 0;
  const applicable = events.filter((e) => Number(e.sequenceId) <= seq);
  const last = applicable[applicable.length - 1];
  return {
    sequenceId: seq,
    eventCount: applicable.length,
    lastEventId: last?.eventId || null,
    payload: last?.payload || null
  };
}

module.exports = {
  buildCausalTree,
  buildCausalTreeFromEvents,
  findDivergencePoints,
  deterministicStateAtSequence,
  getShipmentEventsWithCausality
};
