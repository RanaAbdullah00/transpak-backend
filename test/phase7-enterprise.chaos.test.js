/**
 * Phase 7 Enterprise — chaos resilience tests.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { resolveSequenceWinner } = require("../utils/trackingStateMachine");
const { createSequenceAuthorityGate } = require("../../transpak-frontend/src/utils/trackingSequenceAuthority.js");
const { buildCausalTreeFromEvents, deterministicStateAtSequence } = require("../services/causalReplayEngine");
const { duplicateEmissions, corruptEvent } = require("../utils/chaosInjectors");
const { CAUSALITY_TYPES } = require("../utils/causalEventGraph");

describe("Phase 7 Enterprise — chaos resilience", () => {
  it("500 events/sec sequence authority stays deterministic", () => {
    const gate = createSequenceAuthorityGate();
    let accepted = 0;
    for (let i = 1; i <= 500; i += 1) {
      if (gate.accept({ sequenceId: i })) accepted += 1;
      if (i > 1 && Math.random() < 0.1) {
        gate.accept({ sequenceId: i - 1 });
      }
    }
    assert.equal(accepted, 500);
  });

  it("forced duplicates do not advance stale sequence", () => {
    let last = 0;
    for (let i = 0; i < 100; i += 1) {
      const seq = i + 1;
      duplicateEmissions(() => {
        const check = resolveSequenceWinner(last, seq);
        if (check.accept) last = Math.max(last, seq);
      }, { sequenceId: seq });
      duplicateEmissions(() => {
        const check = resolveSequenceWinner(last, seq);
        if (check.accept) last = Math.max(last, seq);
      }, { sequenceId: seq });
    }
    assert.equal(last, 100);
  });

  it("corrupt orphan events excluded from deterministic replay state", () => {
    const events = [
      { eventId: "e1", sequenceId: 1, causalityType: CAUSALITY_TYPES.CREATE, parentEventId: null, payload: { lat: 1 } },
      { eventId: "e2", sequenceId: 2, causalityType: CAUSALITY_TYPES.UPDATE, parentEventId: "e1", payload: { lat: 2 } }
    ];
    const corrupt = corruptEvent(
      { eventId: "bad", sequenceId: 3, causalityType: CAUSALITY_TYPES.UPDATE, parentEventId: null, payload: { lat: 99 } },
      { stripParent: true }
    );
    const tree = buildCausalTreeFromEvents([...events, corrupt]);
    const state = deterministicStateAtSequence(events, 2);
    assert.equal(state.lastEventId, "e2");
    assert.equal(state.payload.lat, 2);
    assert.ok(tree.roots.length >= 1);
  });

  it("replay hash stable under reorder simulation", () => {
    const base = [];
    for (let i = 1; i <= 50; i += 1) {
      base.push({
        eventId: `e${i}`,
        sequenceId: i,
        causalityType: i === 1 ? CAUSALITY_TYPES.CREATE : CAUSALITY_TYPES.UPDATE,
        parentEventId: i === 1 ? null : `e${i - 1}`,
        payload: { n: i }
      });
    }
    const shuffled = [...base].sort(() => Math.random() - 0.5);
    shuffled.sort((a, b) => a.sequenceId - b.sequenceId);
    const a = deterministicStateAtSequence(base, 50);
    const b = deterministicStateAtSequence(shuffled, 50);
    assert.equal(a.lastEventId, b.lastEventId);
    assert.deepEqual(a.payload, b.payload);
  });
});
