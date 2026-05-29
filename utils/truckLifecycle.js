/**
 * Phase 5 — truck fleet lifecycle (canonical DB values).
 */
const TRUCK_STATUS = {
  PENDING: "pending",
  APPROVED: "approved",
  SUSPENDED: "suspended"
};

/** SQL fragment: trucks eligible for marketplace matching. */
const MATCHING_ELIGIBLE_STATUS_SQL = `t.status IN ('approved')`;

const LEGACY_STATUS_MAP = {
  active: TRUCK_STATUS.APPROVED,
  pending_verification: TRUCK_STATUS.PENDING
};

function normalizeTruckStatus(status) {
  const s = String(status || "")
    .trim()
    .toLowerCase();
  if (LEGACY_STATUS_MAP[s]) return LEGACY_STATUS_MAP[s];
  if (Object.values(TRUCK_STATUS).includes(s)) return s;
  return s || TRUCK_STATUS.PENDING;
}

function isApprovedForMatching(status) {
  const n = normalizeTruckStatus(status);
  return n === TRUCK_STATUS.APPROVED;
}

function isPending(status) {
  return normalizeTruckStatus(status) === TRUCK_STATUS.PENDING;
}

function isSuspended(status) {
  return normalizeTruckStatus(status) === TRUCK_STATUS.SUSPENDED;
}

/** API label for clients */
function apiTruckStatus(status) {
  const n = normalizeTruckStatus(status);
  if (n === TRUCK_STATUS.APPROVED) return "APPROVED";
  if (n === TRUCK_STATUS.SUSPENDED) return "SUSPENDED";
  return "PENDING";
}

function hasRequiredDocuments(truck) {
  const front = String(truck?.truck_card_front_image ?? truck?.truckCardFrontImage ?? "").trim();
  const back = String(truck?.truck_card_back_image ?? truck?.truckCardBackImage ?? "").trim();
  return front.length > 0 && back.length > 0;
}

module.exports = {
  TRUCK_STATUS,
  MATCHING_ELIGIBLE_STATUS_SQL,
  normalizeTruckStatus,
  isApprovedForMatching,
  isPending,
  isSuspended,
  apiTruckStatus,
  hasRequiredDocuments
};
