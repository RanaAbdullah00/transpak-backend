const BID = {
  PENDING: "pending",
  COUNTERED: "suggested",
  ACCEPTED: "accepted",
  REJECTED: "rejected"
};

const LOAD = {
  POSTED: "open",
  ACTIVE: "booked",
  COMPLETED: "closed"
};

const ALLOWED_BID_TRANSITIONS = {
  pending: new Set(["suggested", "accepted", "rejected"]),
  suggested: new Set(["pending", "accepted", "rejected"]),
  accepted: new Set(),
  rejected: new Set(["pending"]),
  cancelled: new Set()
};

function normalizeBidStatus(status) {
  const s = String(status || "").toLowerCase().trim();
  if (s === "countered") return BID.COUNTERED;
  return s;
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
  if (s === BID.COUNTERED) return "COUNTERED";
  if (s === BID.PENDING) return "PENDING";
  if (s === BID.ACCEPTED) return "ACCEPTED";
  if (s === BID.REJECTED) return "REJECTED";
  return String(dbStatus || "").toUpperCase();
}

function apiLoadStatus(dbStatus) {
  const s = String(dbStatus || "").toLowerCase();
  if (s === "open") return "POSTED";
  if (s === "booked") return "ACTIVE";
  if (s === "closed") return "COMPLETED";
  if (s === "cancelled") return "REJECTED";
  return String(dbStatus || "").toUpperCase();
}

module.exports = {
  BID,
  LOAD,
  assertBidTransition,
  apiBidStatus,
  apiLoadStatus,
  normalizeBidStatus
};
