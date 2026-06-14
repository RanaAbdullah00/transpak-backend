const ALLOWED = {
  request_sent: new Set(["active", "rejected"]),
  active: new Set(["in_transit", "completed"]),
  in_transit: new Set(["completed"]),
  completed: new Set(),
  rejected: new Set()
};

function assertSpaceTransition(from, to) {
  const f = String(from || "").toLowerCase();
  const t = String(to || "").toLowerCase();
  const allowed = ALLOWED[f];
  if (!allowed) {
    const err = new Error(`Invalid space request status: ${f}`);
    err.statusCode = 409;
    err.code = "INVALID_SPACE_STATE";
    throw err;
  }
  if (!allowed.has(t)) {
    const err = new Error(`Cannot transition space request from ${f} to ${t}`);
    err.statusCode = 409;
    err.code = "INVALID_SPACE_TRANSITION";
    throw err;
  }
}

/** Pending carrier/shipper action — awaiting accept/reject only. */
const REQUEST_SENT_OPS_STATUSES = ["request_sent"];
const REQUEST_SENT_OPS_SQL = "r.status = 'request_sent'";

module.exports = { assertSpaceTransition, REQUEST_SENT_OPS_STATUSES, REQUEST_SENT_OPS_SQL };
