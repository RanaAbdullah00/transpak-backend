/**
 * Phase 6 — tracking coordinator state machine (backend authoritative hints).
 */
const STATES = Object.freeze({
  INIT: "INIT",
  SOCKET_ACTIVE: "SOCKET_ACTIVE",
  REHYDRATING: "REHYDRATING",
  SYNCED: "SYNCED",
  DEGRADED_POLLING: "DEGRADED_POLLING",
  RECOVERED: "RECOVERED"
});

const TRANSITIONS = Object.freeze({
  INIT: new Set(["SOCKET_ACTIVE", "REHYDRATING", "DEGRADED_POLLING", "SYNCED"]),
  SOCKET_ACTIVE: new Set(["REHYDRATING", "SYNCED", "DEGRADED_POLLING"]),
  REHYDRATING: new Set(["SYNCED", "SOCKET_ACTIVE", "DEGRADED_POLLING", "RECOVERED"]),
  SYNCED: new Set(["SOCKET_ACTIVE", "REHYDRATING", "DEGRADED_POLLING"]),
  DEGRADED_POLLING: new Set(["SOCKET_ACTIVE", "REHYDRATING", "RECOVERED", "SYNCED"]),
  RECOVERED: new Set(["SOCKET_ACTIVE", "SYNCED", "REHYDRATING", "DEGRADED_POLLING"])
});

function validateTrackingStateTransition(fromState, toState) {
  const from = String(fromState || STATES.INIT).toUpperCase();
  const to = String(toState || "").toUpperCase();
  if (!TRANSITIONS[from]) return { ok: false, reason: "unknown_from" };
  if (!Object.values(STATES).includes(to)) return { ok: false, reason: "unknown_to" };
  if (from === to) return { ok: true, same: true };
  if (!TRANSITIONS[from].has(to)) return { ok: false, reason: "invalid_transition", from, to };
  return { ok: true, from, to };
}

function mapSourceToTrackingState(source) {
  const s = String(source || "").toLowerCase();
  if (s === "rehydrate" || s === "api") return STATES.REHYDRATING;
  if (s === "socket") return STATES.SOCKET_ACTIVE;
  if (s === "polling") return STATES.DEGRADED_POLLING;
  return STATES.SYNCED;
}

function resolveSequenceWinner(existingSeq, incomingSeq) {
  const a = Number(existingSeq) || 0;
  const b = Number(incomingSeq) || 0;
  if (!b) return { accept: true, reason: "no_incoming_seq" };
  if (!a) return { accept: true, reason: "first_seq" };
  if (b > a) return { accept: true, reason: "newer_sequence" };
  if (b === a) return { accept: false, reason: "duplicate_sequence" };
  return { accept: false, reason: "stale_sequence" };
}

module.exports = {
  STATES,
  TRANSITIONS,
  validateTrackingStateTransition,
  mapSourceToTrackingState,
  resolveSequenceWinner
};
