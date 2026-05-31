const { notifyUser } = require("./notifyEvent");
const { emitDispatchEvent, emitEntityDispatch, newEventId } = require("./realtimeDispatch");

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
  return notifyUser({
    receiverId,
    senderId: senderId || null,
    roleType,
    title: title || dispatchType,
    type: dispatchType,
    message: message || title || dispatchType
  });
}

/** List refresh on actor workspace without a new notification row. */
function emitBidRefresh(userId, roleType, dispatchType = BID_DISPATCH.UPDATED, payload = null) {
  if (!userId || !roleType) return;
  emitDispatchEvent({
    eventId: newEventId(),
    type: dispatchType,
    receiverId: userId,
    roleType,
    entityType: payload?.bidId ? "bid" : null,
    entityId: payload?.bidId || null,
    payload
  });
  if (payload?.bidId) {
    emitEntityDispatch({
      entityType: "bid",
      entityId: payload.bidId,
      type: dispatchType,
      eventId: newEventId(),
      payload
    });
  }
}

module.exports = {
  BID_DISPATCH,
  emitBidStateChange,
  emitBidRefresh
};
