/**
 * Phase 7 — global consistency engine.
 * sequenceId = ordering; parentEventId + causalityType = correctness; timestamp = UI hint.
 */
const crypto = require("crypto");
const {
  validateTrackingStateTransition,
  resolveSequenceWinner
} = require("./trackingStateMachine");
const {
  CAUSALITY_TYPES,
  buildNode,
  validateGraphIntegrity,
  inferRootCausality
} = require("./causalEventGraph");

function enforceSequenceIntegrity(prevSeq, incomingSeq) {
  return resolveSequenceWinner(prevSeq, incomingSeq);
}

function resolveConflict(eventA, eventB) {
  const a = eventA || {};
  const b = eventB || {};
  const seqA = Number(a.sequenceId) || 0;
  const seqB = Number(b.sequenceId) || 0;
  if (seqA === seqB) {
    const typeRank = (t) => {
      if (t === CAUSALITY_TYPES.CORRECTION) return 3;
      if (t === CAUSALITY_TYPES.REPLAY) return 2;
      return 1;
    };
    const rankA = typeRank(a.causalityType);
    const rankB = typeRank(b.causalityType);
    if (rankA === rankB) return { winner: a, loser: b, reason: "tie_sequence" };
    return rankA > rankB
      ? { winner: a, loser: b, reason: "causality_rank" }
      : { winner: b, loser: a, reason: "causality_rank" };
  }
  return seqA > seqB
    ? { winner: a, loser: b, reason: "newer_sequence" }
    : { winner: b, loser: a, reason: "newer_sequence" };
}

function emitCorrectionEvent(ctx = {}) {
  const loser = ctx.loser || ctx.conflictingEvent || {};
  const winner = ctx.winner || {};
  const eventId =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString("hex");
  return buildNode({
    eventId,
    sequenceId: Math.max(Number(winner.sequenceId) || 0, Number(loser.sequenceId) || 0) + 1,
    parentEventId: loser.eventId || ctx.parentEventId || null,
    causalityType: CAUSALITY_TYPES.CORRECTION,
    payload: {
      correctedEventId: loser.eventId || null,
      winnerEventId: winner.eventId || null,
      reason: ctx.reason || "conflict_resolution",
      ...(ctx.payloadExtra || {})
    }
  });
}

function prepareTrackingEvent({
  eventId,
  sequenceId,
  parentEventId,
  causalityType,
  existingEvents = [],
  prevSeq = 0,
  fromTrackingState,
  toTrackingState,
  reconstructOrphans = false
}) {
  const seqCheck = enforceSequenceIntegrity(prevSeq, sequenceId);
  if (!seqCheck.accept && seqCheck.reason === "stale_sequence") {
    return { ok: false, reason: "stale_sequence", seqCheck };
  }

  if (fromTrackingState && toTrackingState) {
    const sm = validateTrackingStateTransition(fromTrackingState, toTrackingState);
    if (!sm.ok && !sm.same) {
      return { ok: false, reason: "invalid_state_transition", sm };
    }
  }

  const isFirst = existingEvents.length === 0;
  let resolvedParent = parentEventId ? String(parentEventId).slice(0, 128) : null;
  let resolvedType = causalityType || inferRootCausality(existingEvents.length);
  let didReconstruct = false;

  if (!resolvedParent && existingEvents.length > 0) {
    const last = existingEvents[existingEvents.length - 1];
    if (reconstructOrphans) {
      resolvedParent = last?.eventId || null;
      resolvedType = CAUSALITY_TYPES.CORRECTION;
      didReconstruct = true;
    } else if (resolvedType !== CAUSALITY_TYPES.CREATE && resolvedType !== CAUSALITY_TYPES.REPLAY) {
      return { ok: false, reason: "orphan_event", orphan: true };
    }
  }

  const node = buildNode({
    eventId,
    sequenceId,
    parentEventId: resolvedParent,
    causalityType: resolvedType
  });

  const graphCheck = validateGraphIntegrity([...existingEvents, node], { isFirstEvent: isFirst });
  if (!graphCheck.ok) {
    if (reconstructOrphans) {
      const correction = emitCorrectionEvent({
        loser: node,
        winner: existingEvents[existingEvents.length - 1],
        reason: "orphan_reconstruction"
      });
      return { ok: true, node: correction, reconstructed: true, seqCheck };
    }
    return { ok: false, reason: "causal_graph_invalid", graphCheck };
  }

  return { ok: true, node, seqCheck, reconstructed: didReconstruct || graphCheck.reconstructed || false };
}

module.exports = {
  validateStateTransition: validateTrackingStateTransition,
  enforceSequenceIntegrity,
  resolveConflict,
  emitCorrectionEvent,
  prepareTrackingEvent
};
