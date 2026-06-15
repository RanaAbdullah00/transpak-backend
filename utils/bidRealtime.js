const { notifyUnified } = require("./notifyUnified");
const { emitContractDispatch, emitContractEntityDispatch } = require("./eventContractRegistry");
const { newEventId } = require("./realtimeDispatch");

const BID_DISPATCH = {
  CREATED: "BID_CREATED",
  UPDATED: "BID_UPDATED",
  ACCEPTED: "BID_ACCEPTED",
  REJECTED: "BID_REJECTED",
  COUNTER: "BID_COUNTER"
};

/** Persist notification + socket dispatch for bid lifecycle (receiver workspace). */
async function emitBidStateChange({
  receiverId,
  senderId,
  roleType,
  dispatchType,
  title,
  message
}) {
  if (!receiverId || !roleType || !dispatchType) return null;
  return notifyUnified(dispatchType, {
    receiverId,
    senderId: senderId || null,
    roleType,
    title: title || dispatchType,
    message: message || title || dispatchType
  });
}

/** List refresh on actor workspace without a new notification row. */
function emitBidRefresh(userId, roleType, dispatchType = BID_DISPATCH.UPDATED, payload = null) {
  if (!userId || !roleType) return;
  emitContractDispatch({
    eventId: newEventId(),
    type: dispatchType,
    receiverId: userId,
    roleType,
    entityType: payload?.bidId ? "bid" : null,
    entityId: payload?.bidId || null,
    payload
  });
  if (payload?.bidId) {
    emitContractEntityDispatch({
      entityType: "bid",
      entityId: payload.bidId,
      type: dispatchType,
      eventId: newEventId(),
      payload
    });
  }
}

/** Notify losing bidders + refresh marketplace after accept (no refresh required on clients). */
async function emitBidAcceptMarketplaceFanout({
  loadId,
  winningBidId,
  winningCarrierId,
  shipperId,
  loadCode
}) {
  if (!loadId) return;
  const { query } = require("../db/pool");
  const { rows } = await query(
    `SELECT DISTINCT b.carrier_id AS "carrierId"
     FROM bids b
     WHERE b.load_id = $1
       AND b.id <> $2
       AND b.carrier_id IS NOT NULL
       AND b.carrier_id <> $3`,
    [loadId, winningBidId, winningCarrierId]
  );

  const payload = { loadId, loadCode: loadCode || null, loadFlowStatus: "BOOKED" };

  for (const row of rows) {
    const carrierId = String(row.carrierId || "");
    if (!carrierId) continue;
    void emitBidStateChange({
      receiverId: carrierId,
      senderId: shipperId,
      roleType: "carrier",
      dispatchType: BID_DISPATCH.REJECTED,
      title: "LOAD_BOOKED",
      message: "This load was booked by another carrier."
    });
    emitBidRefresh(carrierId, "carrier", BID_DISPATCH.REJECTED, payload);
    emitBidRefresh(carrierId, "carrier", "LOAD_ACCEPTED", payload);
  }

  emitContractDispatch({
    eventId: newEventId(),
    type: "LOAD_ACCEPTED",
    receiverId: winningCarrierId,
    roleType: "carrier",
    entityType: "load",
    entityId: loadId,
    payload
  });
  if (shipperId) {
    emitContractDispatch({
      eventId: newEventId(),
      type: "LOAD_ACCEPTED",
      receiverId: shipperId,
      roleType: "shipper",
      entityType: "load",
      entityId: loadId,
      payload
    });
  }
}

module.exports = {
  BID_DISPATCH,
  emitBidStateChange,
  emitBidRefresh,
  emitBidAcceptMarketplaceFanout
};
