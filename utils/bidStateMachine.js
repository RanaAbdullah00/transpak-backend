const BID = {
  PENDING_SHIPPER: "pending_shipper_confirmation",
  COUNTER: "counter_offered",
  ACCEPTED: "accepted",
  REJECTED: "rejected",
  CANCELLED: "cancelled",
  /** @deprecated use PENDING_SHIPPER */
  PENDING: "pending_shipper_confirmation",
  /** @deprecated use COUNTER */
  COUNTERED: "counter_offered"
};

const LOAD = {
  POSTED: "open",
  ACTIVE: "booked",
  COMPLETED: "closed"
};

const MAX_COUNTER_ROUNDS = Number(process.env.BID_MAX_COUNTER_ROUNDS || 5);

/** SQL fragment for open/active bids on a load */
const ACTIVE_BID_STATUSES_SQL =
  "('pending_shipper_confirmation','counter_offered','pending','suggested')";

const ALLOWED_BID_TRANSITIONS = {
  pending_shipper_confirmation: new Set(["counter_offered", "accepted", "rejected"]),
  counter_offered: new Set(["pending_shipper_confirmation", "accepted", "rejected"]),
  accepted: new Set(),
  rejected: new Set(["pending_shipper_confirmation"]),
  cancelled: new Set()
};

function normalizeBidStatus(status) {
  const s = String(status || "")
    .toLowerCase()
    .trim();
  if (s === "pending" || s === "pending_shipper_confirmation") return BID.PENDING_SHIPPER;
  if (s === "suggested" || s === "countered" || s === "counter_offered") return BID.COUNTER;
  return s;
}

function isCounterOffered(status) {
  return normalizeBidStatus(status) === BID.COUNTER;
}

function isAwaitingShipper(status) {
  return normalizeBidStatus(status) === BID.PENDING_SHIPPER;
}

function assertCounterLimit(counterRoundCount) {
  const n = Number(counterRoundCount) || 0;
  if (n >= MAX_COUNTER_ROUNDS) {
    const err = new Error(`Maximum ${MAX_COUNTER_ROUNDS} counter offers reached for this bid`);
    err.statusCode = 409;
    err.code = "COUNTER_LIMIT_REACHED";
    throw err;
  }
}

function assertBidTransition(fromStatus, toStatus) {
  const from = normalizeBidStatus(fromStatus);
  const to = normalizeBidStatus(toStatus);
  const allowed = ALLOWED_BID_TRANSITIONS[from];
  if (!allowed) {
    const err = new Error(`Invalid bid status: ${from}`);
    err.statusCode = 409;
    err.code = "INVALID_BID_STATE";
    throw err;
  }
  if (!allowed.has(to)) {
    const err = new Error(`Cannot transition bid from ${from} to ${to}`);
    err.statusCode = 409;
    err.code = "INVALID_BID_TRANSITION";
    throw err;
  }
}

function apiBidStatus(dbStatus) {
  const s = normalizeBidStatus(dbStatus);
  if (s === BID.COUNTER) return "COUNTER_OFFERED";
  if (s === BID.PENDING_SHIPPER) return "PENDING_SHIPPER_CONFIRMATION";
  if (s === BID.ACCEPTED) return "ACCEPTED";
  if (s === BID.REJECTED) return "REJECTED";
  if (s === BID.CANCELLED) return "CANCELLED";
  return String(dbStatus || "").toUpperCase();
}

function apiLoadStatus(dbStatus) {
  const s = String(dbStatus || "").toLowerCase();
  if (s === "open") return "POSTED";
  if (s === "booked") return "ACTIVE";
  if (s === "closed") return "COMPLETED";
  if (s === "cancelled") return "CANCELLED";
  return String(dbStatus || "").toUpperCase();
}

module.exports = {
  BID,
  LOAD,
  ACTIVE_BID_STATUSES_SQL,
  MAX_COUNTER_ROUNDS,
  assertBidTransition,
  assertCounterLimit,
  apiBidStatus,
  apiLoadStatus,
  normalizeBidStatus,
  isCounterOffered,
  isAwaitingShipper
};
