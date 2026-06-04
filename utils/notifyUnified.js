const { assertEventType } = require("./eventContractRegistry");
const {
  notifyUser: notifyUserCore,
  notifyLoadPostedToCarriers,
  notifyAdmins,
  flushAllNotificationQueues,
  dedupeKeyFromContent
} = require("./notifyEvent");

/**
 * All persisted notifications must use a registry event type.
 * @param {string} event
 * @param {{ receiverId, senderId?, roleType, title?, message, idempotencyKey? }} payload
 */
async function notifyUnified(event, payload) {
  const type = assertEventType(event);
  if (!payload?.receiverId || !payload?.message) return null;
  return notifyUserCore({
    receiverId: payload.receiverId,
    senderId: payload.senderId ?? null,
    roleType: payload.roleType,
    title: payload.title || type,
    type,
    message: payload.message,
    idempotencyKey: payload.idempotencyKey
  });
}

module.exports = {
  notifyUnified,
  notifyLoadPostedToCarriers,
  notifyAdmins,
  flushAllNotificationQueues,
  dedupeKeyFromContent
};
