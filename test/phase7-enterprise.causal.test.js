/**
 * Phase 7 Enterprise — causal integrity tests.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildNode,
  detectOrphans,
  validateGraphIntegrity,
  buildAdjacencyList,
  CAUSALITY_TYPES
} = require("../utils/causalEventGraph");
const { prepareTrackingEvent, resolveConflict, emitCorrectionEvent } = require("../utils/consistencyEngine");
const { buildCausalTreeFromEvents } = require("../services/causalReplayEngine");

describe("Phase 7 Enterprise — causal graph", () => {
  it("detects orphan when parent missing", () => {
    const nodes = [
      buildNode({ eventId: "a", sequenceId: 1, causalityType: CAUSALITY_TYPES.CREATE }),
      buildNode({ eventId: "b", sequenceId: 2, parentEventId: "missing", causalityType: CAUSALITY_TYPES.UPDATE })
    ];
    const orphans = detectOrphans(nodes);
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].reason, "parent_not_found");
  });

  it("validates CREATE root without parent", () => {
    const nodes = [buildNode({ eventId: "root", sequenceId: 1, causalityType: CAUSALITY_TYPES.CREATE })];
    const check = validateGraphIntegrity(nodes, { isFirstEvent: true });
    assert.equal(check.ok, true);
  });

  it("prepareTrackingEvent rejects orphan when reconstruct off", () => {
    const existing = [buildNode({ eventId: "e1", sequenceId: 1, causalityType: CAUSALITY_TYPES.CREATE })];
    const result = prepareTrackingEvent({
      eventId: "e2",
      sequenceId: 2,
      parentEventId: null,
      causalityType: CAUSALITY_TYPES.UPDATE,
      existingEvents: existing,
      reconstructOrphans: false
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "orphan_event");
  });

  it("prepareTrackingEvent reconstructs orphan when enabled", () => {
    const existing = [buildNode({ eventId: "e1", sequenceId: 1, causalityType: CAUSALITY_TYPES.CREATE })];
    const result = prepareTrackingEvent({
      eventId: "e2",
      sequenceId: 2,
      parentEventId: null,
      causalityType: CAUSALITY_TYPES.UPDATE,
      existingEvents: existing,
      reconstructOrphans: true
    });
    assert.equal(result.ok, true);
    assert.equal(result.reconstructed, true);
    assert.equal(result.node.causalityType, CAUSALITY_TYPES.CORRECTION);
  });

  it("resolveConflict prefers higher sequenceId", () => {
    const a = buildNode({ eventId: "a", sequenceId: 5 });
    const b = buildNode({ eventId: "b", sequenceId: 10 });
    const { winner } = resolveConflict(a, b);
    assert.equal(winner.eventId, "b");
  });

  it("buildCausalTreeFromEvents produces roots and corrections", () => {
    const events = [
      { eventId: "r", sequenceId: 1, causalityType: CAUSALITY_TYPES.CREATE, parentEventId: null, payload: {} },
      { eventId: "c", sequenceId: 2, causalityType: CAUSALITY_TYPES.CORRECTION, parentEventId: "r", payload: {} }
    ];
    const tree = buildCausalTreeFromEvents(events);
    assert.ok(tree.roots.includes("r"));
    assert.ok(tree.corrections.includes("c"));
  });

  it("emitCorrectionEvent links to loser parent", () => {
    const correction = emitCorrectionEvent({
      loser: { eventId: "bad", sequenceId: 3 },
      winner: { eventId: "good", sequenceId: 4 }
    });
    assert.equal(correction.causalityType, CAUSALITY_TYPES.CORRECTION);
    assert.equal(correction.parentEventId, "bad");
  });
});
